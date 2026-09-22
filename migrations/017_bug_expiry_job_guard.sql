BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION otl.bug_expire_due_intakes(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  batch_limit integer:=coalesce((p->>'limit')::integer,10);
  report otl.bug_reports;
  conversation_digest text;
  reason text;
  expired integer:=0;
BEGIN
  IF jsonb_typeof(p)<>'object' OR batch_limit NOT BETWEEN 1 AND 25
  THEN RAISE EXCEPTION 'invalid expiry batch' USING ERRCODE='22023'; END IF;
  FOR report IN
    SELECT r.* FROM otl.bug_reports r
    WHERE r.state='needs_info'
      AND r.source='slack'
      AND r.source_channel_id IS NOT NULL
      AND r.source_thread IS NOT NULL
      AND (r.question_count>=5 OR r.needs_info_started_at+interval '24 hours'<=at_time)
    ORDER BY coalesce(r.needs_info_started_at,r.created_at),r.bug_id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_limit
  LOOP
    SELECT object_digest INTO STRICT conversation_digest
    FROM otl.bug_report_revisions
    WHERE bug_id=report.bug_id AND packet_revision=report.packet_revision;
    reason:=CASE WHEN report.question_count>=5 THEN 'five' ELSE '24h' END;
    INSERT INTO otl.bug_events(
      bug_id,idempotency_key,from_state,to_state,variant,revision,
      actors,guard_code,evidence,occurred_at
    ) VALUES(
      report.bug_id,'system:needs-info-expiry:'||report.revision,
      'needs_info','needs_info_exhausted','',report.revision+1,
      '["scheduler"]'::jsonb,'exhausted',
      jsonb_build_object('conversationDigest',conversation_digest,'exhaustionReason',reason),at_time
    );
    UPDATE otl.bug_reports SET
      state='needs_info_exhausted',revision=report.revision+1,updated_at=at_time
    WHERE bug_id=report.bug_id AND state='needs_info' AND revision=report.revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'expiry report race' USING ERRCODE='40001'; END IF;
    INSERT INTO otl.bug_deliveries(
      delivery_key,delivery_kind,team_id,bug_id,packet_revision,destination,
      template_id,renderer_version,not_before
    ) VALUES
      (report.bug_id||':'||report.packet_revision||':receipt:reporter_ephemeral',
       'receipt',report.team_id,report.bug_id,report.packet_revision,'reporter_ephemeral',
       'receipt.exhausted.v1','bug-receipt.v1',at_time),
      (report.bug_id||':'||report.packet_revision||':admin_handoff:admin_channel',
       'admin_handoff',report.team_id,report.bug_id,report.packet_revision,'admin_channel',
       'admin_handoff.exhausted.v1','bug-handoff.v1',at_time)
    ON CONFLICT (bug_id,packet_revision,delivery_kind,destination) DO NOTHING;
    expired:=expired+1;
  END LOOP;
  RETURN to_jsonb(expired);
END $$;

CREATE OR REPLACE FUNCTION otl.bug_answer_revision(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; q otl.bug_questions; next_revision integer; claimed_revision integer; claimed_operation text; f jsonb := p->'sanitizedFields'; rev otl.bug_report_revisions;
BEGIN
  IF coalesce(p->>'idempotencyKey','')='' THEN RAISE EXCEPTION 'answer idempotency required' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  SELECT packet_revision,operation INTO claimed_revision,claimed_operation FROM otl.bug_revision_claims WHERE bug_id=p->>'bugId' AND idempotency_key=p->>'idempotencyKey';
  IF FOUND THEN
    IF claimed_operation<>'answer' THEN RAISE EXCEPTION 'idempotency operation mismatch' USING ERRCODE='22023'; END IF;
    RETURN (SELECT to_jsonb(saved) FROM otl.bug_report_revisions saved WHERE saved.bug_id=p->>'bugId' AND saved.packet_revision=claimed_revision);
  END IF;
  IF r.bug_id IS NULL OR r.state<>'needs_info' OR r.reporter_id<>p->>'reporterId' OR r.packet_revision<>(p->>'expectedPacketRevision')::integer OR jsonb_typeof(f)<>'object'
     OR NOT (f ?& ARRAY['actual','expected','steps','location','occurredAt','frequency','impact'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['actual','expected','steps','location','occurredAt','frequency','impact']))
     OR jsonb_typeof(f->'steps')<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(f->'steps') step WHERE jsonb_typeof(step)<>'string') THEN
    RAISE EXCEPTION 'answer conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO q FROM otl.bug_questions WHERE bug_id=r.bug_id AND question_id=p->>'questionId' FOR UPDATE;
  IF NOT FOUND OR q.answer_digest IS NOT NULL OR coalesce(p->>'answerDigest','') !~ '^[0-9a-f]{64}$' OR coalesce(p->>'answerOpaqueRef','')='' OR jsonb_typeof(p->'completeness')<>'object' THEN
    RAISE EXCEPTION 'invalid answer' USING ERRCODE='22023';
  END IF;
  next_revision:=r.packet_revision+1;
  INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce)
  SELECT r.bug_id,next_revision,'bug_intake.v1','answered',f,p->>'opaqueRef',p->>'objectDigest',p->>'envelopeDek',p->>'kekVersion',p->>'nonce' RETURNING * INTO rev;
  UPDATE otl.bug_questions SET answer_digest=p->>'answerDigest',answer_opaque_ref=p->>'answerOpaqueRef',answer_packet_revision=next_revision,completeness=p->'completeness',answered_at=clock_timestamp() WHERE bug_id=r.bug_id AND question_id=q.question_id;
  UPDATE otl.bug_reports SET packet_revision=next_revision,actual=f->>'actual',expected=f->>'expected',steps=coalesce(f->'steps','[]'),location=f->>'location',occurred_at=nullif(f->>'occurredAt','')::timestamptz,frequency=f->>'frequency',impact=f->>'impact',updated_at=clock_timestamp() WHERE bug_id=r.bug_id;
  INSERT INTO otl.bug_revision_claims VALUES(r.bug_id,p->>'idempotencyKey','answer',next_revision);
  RETURN to_jsonb(rev);
END $$;

CREATE OR REPLACE FUNCTION otl.bug_enqueue_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  RAISE EXCEPTION 'direct job enqueue denied; use guarded transition' USING ERRCODE='42501';
END $$;

REVOKE EXECUTE ON FUNCTION otl.bug_expire_due_intakes(jsonb),otl.bug_enqueue_job(jsonb) FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('017-bug-expiry-job-guard');
COMMIT;
