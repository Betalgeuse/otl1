BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The application asks at most three clarification questions. Keep PostgreSQL's
-- transition and scheduler guards on the same boundary so the third answer can
-- hand the specification to an administrator instead of opening question four.
CREATE OR REPLACE FUNCTION otl.bug_transition(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; c otl.bug_transition_contract; e otl.bug_events; actors jsonb:=p->'actors'; g jsonb:=p->'guard'; evidence jsonb:=p->'evidence'; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); chosen_variant text:=coalesce(p->>'variant',''); k text; requirement jsonb; actors_ok boolean:=false; job_kind text;
BEGIN
  IF jsonb_typeof(p)<>'object' OR jsonb_typeof(actors)<>'array' OR jsonb_array_length(actors)=0 OR jsonb_typeof(g)<>'object' OR jsonb_typeof(evidence)<>'object' OR coalesce(p->>'idempotencyKey','')='' THEN RAISE EXCEPTION 'invalid transition input' USING ERRCODE='22023'; END IF;
  IF actors @> '["llm"]'::jsonb THEN RAISE EXCEPTION 'llm cannot mutate state' USING ERRCODE='42501'; END IF;
  SELECT * INTO e FROM otl.bug_events WHERE bug_id=p->>'bugId' AND idempotency_key=p->>'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('changed',false,'idempotent',true,'eventId',e.event_id,'state',e.to_state,'revision',e.revision); END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown bug' USING ERRCODE='22023'; END IF;
  IF r.revision<>(p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'stale revision' USING ERRCODE='40001'; END IF;
  IF r.state='blocked_capacity' AND chosen_variant='' AND p->>'toState' IN ('queued','fixing','reviewing') THEN chosen_variant:=coalesce(r.resume_state,''); END IF;
  SELECT * INTO c FROM otl.bug_transition_contract WHERE from_state=r.state AND to_state=p->>'toState' AND variant=chosen_variant;
  IF NOT FOUND THEN RAISE EXCEPTION 'transition denied' USING ERRCODE='42501'; END IF;
  FOR requirement IN SELECT value FROM jsonb_array_elements(c.actor_requirements) LOOP
    IF actors @> requirement AND requirement @> actors THEN actors_ok:=true; EXIT; END IF;
  END LOOP;
  IF NOT actors_ok THEN RAISE EXCEPTION 'actor denied' USING ERRCODE='42501'; END IF;
  FOREACH k IN ARRAY c.required_guard_keys LOOP IF NOT (g ? k) OR g->k <> 'true'::jsonb THEN RAISE EXCEPTION 'guard failed: %',k USING ERRCODE='23514'; END IF; END LOOP;
  FOREACH k IN ARRAY c.required_evidence_keys LOOP IF NOT (evidence ? k) OR evidence->k IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb) THEN RAISE EXCEPTION 'evidence missing: %',k USING ERRCODE='23514'; END IF; END LOOP;
  IF c.guard_code='packet_complete' AND r.confirmed_packet_digest IS NULL THEN RAISE EXCEPTION 'confirmed packet required' USING ERRCODE='23514'; END IF;
  IF c.guard_code='needs_info_loop' AND (r.question_count>=3 OR NOT (evidence ? 'questionId') OR EXISTS(SELECT 1 FROM otl.bug_questions WHERE bug_id=r.bug_id AND question_id=evidence->>'questionId')) THEN RAISE EXCEPTION 'needs-info loop exhausted or repeated' USING ERRCODE='23514'; END IF;
  IF c.guard_code='exhausted' AND NOT (r.question_count>=3 OR r.needs_info_started_at + interval '24 hours' <= at_time) THEN RAISE EXCEPTION 'not exhausted' USING ERRCODE='23514'; END IF;
  IF c.guard_code='reset_once' AND r.needs_info_reset_count<>0 THEN RAISE EXCEPTION 'needs-info reset exhausted' USING ERRCODE='23514'; END IF;
  IF c.guard_code LIKE 'capacity_resume%' OR c.guard_code='capacity_resume' THEN
    IF r.resume_state<>c.resume_state OR r.assigned_alias IS DISTINCT FROM evidence->>'originalAlias' THEN RAISE EXCEPTION 'capacity resume mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  INSERT INTO otl.bug_events(bug_id,idempotency_key,from_state,to_state,variant,revision,actors,guard_code,evidence,occurred_at)
  VALUES(r.bug_id,p->>'idempotencyKey',r.state,c.to_state,c.variant,r.revision+1,actors,c.guard_code,evidence,at_time) RETURNING * INTO e;
  UPDATE otl.bug_reports SET state=c.to_state,revision=revision+1,updated_at=at_time,
    needs_info_started_at=CASE WHEN c.to_state='needs_info' AND c.guard_code='missing_field' THEN at_time WHEN c.guard_code='reset_once' THEN at_time ELSE needs_info_started_at END,
    needs_info_reset_count=needs_info_reset_count+CASE WHEN c.guard_code='reset_once' THEN 1 ELSE 0 END,
    resume_state=CASE WHEN c.to_state='blocked_capacity' THEN c.resume_state WHEN r.state='blocked_capacity' THEN NULL ELSE resume_state END,
    assigned_alias=CASE WHEN c.to_state='blocked_capacity' THEN evidence->>'accountAlias' ELSE assigned_alias END,
    public_export_enabled=CASE WHEN c.to_state='private_incident' THEN false ELSE public_export_enabled END,
    question_count=question_count+CASE WHEN c.side_effect IN ('question','reset_question') THEN 1 ELSE 0 END
  WHERE bug_id=r.bug_id;
  IF c.side_effect IN ('question','reset_question') THEN
    INSERT INTO otl.bug_questions(bug_id,question_id,field_name,template_version,question_text,asked_packet_revision)
    VALUES(r.bug_id,evidence->>'questionId',coalesce(evidence->>'fieldName','unspecified'),coalesce(evidence->>'templateVersion','v1'),coalesce(evidence->>'questionText','sanitized follow-up'),r.packet_revision);
  END IF;
  job_kind:=CASE c.side_effect WHEN 'enqueue_reproduce' THEN 'reproduce' WHEN 'enqueue_fix' THEN 'fix' WHEN 'enqueue_review' THEN 'review' WHEN 'deploy' THEN 'deploy' ELSE NULL END;
  IF job_kind IS NOT NULL THEN
    INSERT INTO otl.bug_jobs(bug_id,event_id,kind,payload,payload_digest,assigned_alias)
    VALUES(r.bug_id,e.event_id,job_kind,jsonb_build_object('state',c.to_state),coalesce(evidence->>'payloadDigest',repeat('0',64)),coalesce(evidence->>'originalAlias',r.assigned_alias)) ON CONFLICT(event_id,kind) DO NOTHING;
  END IF;
  IF c.side_effect='release_lease' THEN UPDATE otl.bug_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,cancel_reason='blocked_capacity',updated_at=at_time WHERE bug_id=r.bug_id AND status='leased'; END IF;
  RETURN jsonb_build_object('changed',true,'idempotent',false,'eventId',e.event_id,'state',c.to_state,'revision',e.revision);
END $$;


CREATE OR REPLACE FUNCTION otl.bug_expire_due_intakes(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  team text:=p->>'teamId';
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  batch_limit integer:=coalesce((p->>'limit')::integer,10);
  report otl.bug_reports;
  conversation_digest text;
  reason text;
  expired integer:=0;
BEGIN
  IF jsonb_typeof(p)<>'object' OR coalesce(team,'') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
     OR batch_limit NOT BETWEEN 1 AND 25
  THEN RAISE EXCEPTION 'invalid expiry batch' USING ERRCODE='22023'; END IF;
  FOR report IN
    SELECT r.* FROM otl.bug_reports r
    WHERE r.team_id=team AND r.state='needs_info'
      AND r.source='slack' AND r.source_channel_id IS NOT NULL AND r.source_thread IS NOT NULL
      AND (r.question_count>=3 OR r.needs_info_started_at+interval '24 hours'<=at_time)
    ORDER BY coalesce(r.needs_info_started_at,r.created_at),r.bug_id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_limit
  LOOP
    SELECT object_digest INTO STRICT conversation_digest
    FROM otl.bug_report_revisions
    WHERE bug_id=report.bug_id AND packet_revision=report.packet_revision;
    reason:=CASE WHEN report.question_count>=3 THEN 'three' ELSE '24h' END;
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
    WHERE team_id=team AND bug_id=report.bug_id AND state='needs_info' AND revision=report.revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'expiry report race' USING ERRCODE='40001'; END IF;
    INSERT INTO otl.bug_deliveries(
      delivery_key,delivery_kind,team_id,bug_id,packet_revision,destination,
      template_id,renderer_version,not_before
    ) VALUES
      (report.bug_id||':'||report.packet_revision||':receipt:reporter_ephemeral',
       'receipt',team,report.bug_id,report.packet_revision,'reporter_ephemeral',
       'receipt.exhausted.v1','bug-receipt.v1',at_time),
      (report.bug_id||':'||report.packet_revision||':admin_handoff:admin_channel',
       'admin_handoff',team,report.bug_id,report.packet_revision,'admin_channel',
       'admin_handoff.exhausted.v1','bug-handoff.v1',at_time)
    ON CONFLICT (bug_id,packet_revision,delivery_kind,destination) DO NOTHING;
    expired:=expired+1;
  END LOOP;
  RETURN to_jsonb(expired);
END $$;

DO $$
BEGIN
  IF position('question_count>=3' IN pg_get_functiondef('otl.bug_transition(jsonb)'::regprocedure))=0
    OR position('question_count>=3' IN pg_get_functiondef('otl.bug_expire_due_intakes(jsonb)'::regprocedure))=0
  THEN RAISE EXCEPTION 'three-question guard not installed'; END IF;
END $$;


INSERT INTO otl.schema_migrations(version) VALUES('048-bug-three-question-limit');
COMMIT;
