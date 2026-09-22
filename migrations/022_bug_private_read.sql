BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION otl.bug_read_owned(
  p_team_id text,p_bug_id text,p_reporter_id text,p_expected_revision integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; rev otl.bug_report_revisions; questions jsonb;
BEGIN
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p_bug_id;
  IF NOT FOUND OR r.team_id<>p_team_id OR r.reporter_id<>p_reporter_id THEN
    RAISE EXCEPTION 'bug read denied' USING ERRCODE='42501';
  END IF;
  IF p_expected_revision IS NOT NULL AND r.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'stale bug read' USING ERRCODE='40001';
  END IF;
  SELECT * INTO rev FROM otl.bug_report_revisions
  WHERE bug_id=r.bug_id AND packet_revision=r.packet_revision;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'questionId',q.question_id,'fieldName',q.field_name,'templateVersion',q.template_version,
    'questionText',q.question_text,'askedPacketRevision',q.asked_packet_revision,
    'askedAt',q.created_at,'answered',q.answer_digest IS NOT NULL,
    'answerDigest',q.answer_digest,'answerOpaqueRef',q.answer_opaque_ref,
    'answerPacketRevision',q.answer_packet_revision,'completeness',q.completeness
  ) ORDER BY q.created_at,q.question_id),'[]'::jsonb)
  INTO questions FROM otl.bug_questions q WHERE q.bug_id=r.bug_id;
  RETURN jsonb_build_object(
    'bugId',r.bug_id,'teamId',r.team_id,'state',r.state,'revision',r.revision,
    'packetRevision',r.packet_revision,'needsInfoStartedAt',r.needs_info_started_at,
    'reporterId',r.reporter_id,'sanitizedFields',rev.sanitized_fields,
    'source',jsonb_strip_nulls(jsonb_build_object(
      'kind',r.source,'opaqueRef',r.source_opaque_ref,
      'channelId',r.source_channel_id,'thread',r.source_thread
    )),
    'currentRevision',jsonb_build_object(
      'packetRevision',rev.packet_revision,'schemaVersion',rev.schema_version,
      'status',rev.status,'latestOpaqueRef',rev.opaque_ref,
      'objectDigest',rev.object_digest,'envelopeDek',rev.envelope_dek,
      'kekVersion',rev.kek_version,'nonce',rev.nonce,
      'evidenceDigest',rev.evidence_digest,'packetDigest',rev.packet_digest,
      'confirmedPacket',rev.confirmed_packet
    ),
    'questions',questions
  );
END $$;
CREATE OR REPLACE FUNCTION otl.bug_claim_due_deliveries(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  team text:=p->>'teamId';
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
  batch_limit integer:=coalesce((p->>'limit')::integer,10);
  route record;
  claimed otl.bug_deliveries;
  obsolete_reason text;
  result jsonb:='[]'::jsonb;
  claimed_count integer:=0;
BEGIN
  IF coalesce(team,'') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
     OR coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')=''
     OR lease_seconds NOT BETWEEN 30 AND 1800 OR batch_limit NOT BETWEEN 1 AND 25
  THEN RAISE EXCEPTION 'invalid due delivery claim' USING ERRCODE='22023'; END IF;
  UPDATE otl.bug_deliveries SET
    status='failed',retry_after=NULL,last_error_code='timeout',worker_id=NULL,
    lease_token=NULL,lease_expires_at=NULL,updated_at=at_time
  WHERE team_id=team AND status='claimed' AND attempts>=3 AND lease_expires_at<at_time;
  FOR route IN
    SELECT d.delivery_id,r.bug_id,r.team_id,r.reporter_id,r.state,r.packet_revision,
      r.source_channel_id,r.source_thread
    FROM otl.bug_deliveries d JOIN otl.bug_reports r ON r.bug_id=d.bug_id
    WHERE d.team_id=team AND r.team_id=team
      AND r.source='slack' AND r.source_channel_id IS NOT NULL AND r.source_thread IS NOT NULL
      AND d.attempts<3 AND (
        (d.status='pending' AND d.not_before<=at_time) OR
        (d.status='failed' AND d.retry_after<=at_time) OR
        (d.status='claimed' AND d.lease_expires_at<at_time)
      )
    ORDER BY CASE WHEN d.status='failed' THEN d.retry_after
      WHEN d.status='claimed' THEN d.lease_expires_at ELSE d.not_before END,d.delivery_id
    FOR UPDATE OF d,r SKIP LOCKED
  LOOP
    EXIT WHEN claimed_count>=batch_limit;
    SELECT * INTO claimed FROM otl.bug_deliveries
    WHERE team_id=team AND delivery_id=route.delivery_id;
    IF claimed.delivery_kind='question' THEN
      PERFORM 1 FROM otl.bug_questions q
      WHERE q.bug_id=claimed.bug_id AND q.question_id=claimed.question_id FOR UPDATE;
    END IF;
    obsolete_reason:=CASE
      WHEN route.packet_revision<>claimed.packet_revision THEN 'obsolete_revision'
      WHEN claimed.delivery_kind='question' AND NOT EXISTS(
        SELECT 1 FROM otl.bug_questions q WHERE q.bug_id=claimed.bug_id
          AND q.question_id=claimed.question_id AND q.answer_digest IS NULL
      ) THEN 'obsolete_question'
      WHEN claimed.delivery_kind='question' AND route.state<>'needs_info' THEN 'obsolete_state'
      WHEN claimed.delivery_kind='summary' AND route.state NOT IN ('new','needs_info') THEN 'obsolete_state'
      WHEN claimed.delivery_kind='receipt' AND NOT (
        route.state='rejected' OR route.state='needs_info_exhausted'
        OR (route.state='private_incident' AND claimed.template_id='receipt.private.v1')
        OR (route.state='triaged' AND EXISTS(
          SELECT 1 FROM otl.bug_report_revisions rev WHERE rev.bug_id=claimed.bug_id
            AND rev.packet_revision=claimed.packet_revision AND rev.status='confirmed'))
      ) THEN 'obsolete_state'
      WHEN claimed.delivery_kind='admin_handoff'
        AND route.state NOT IN ('private_incident','needs_info_exhausted') THEN 'obsolete_state'
    END;
    IF obsolete_reason IS NOT NULL THEN
      UPDATE otl.bug_deliveries SET status='cancelled',cancel_reason=obsolete_reason,
        worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,
        last_error_code=NULL,updated_at=at_time
      WHERE team_id=team AND delivery_id=claimed.delivery_id;
      CONTINUE;
    END IF;
    UPDATE otl.bug_deliveries SET
      status='claimed',attempts=attempts+1,worker_id=p->>'workerId',lease_token=p->>'leaseToken',
      lease_expires_at=at_time+make_interval(secs=>lease_seconds),retry_after=NULL,
      last_error_code=NULL,message_ts=NULL,cancel_reason=NULL,updated_at=at_time
    WHERE team_id=team AND delivery_id=claimed.delivery_id RETURNING * INTO claimed;
    result:=result||jsonb_build_array(
      to_jsonb(claimed)||jsonb_build_object(
        'reporter_id',route.reporter_id,'source_channel_id',route.source_channel_id,
        'source_thread',route.source_thread,'report_revision',(
          SELECT revision FROM otl.bug_reports WHERE team_id=team AND bug_id=route.bug_id),
        'sanitized_fields',(
          SELECT sanitized_fields FROM otl.bug_report_revisions
          WHERE bug_id=claimed.bug_id AND packet_revision=claimed.packet_revision),
        'private_revision',(
          SELECT jsonb_build_object(
            'packetRevision',rev.packet_revision,'schemaVersion',rev.schema_version,
            'opaqueRef',rev.opaque_ref,'objectDigest',rev.object_digest,
            'envelopeDek',rev.envelope_dek,'kekVersion',rev.kek_version,'nonce',rev.nonce
          ) FROM otl.bug_report_revisions rev
          WHERE rev.bug_id=claimed.bug_id AND rev.packet_revision=claimed.packet_revision)
      )
    );
    claimed_count:=claimed_count+1;
  END LOOP;
  RETURN result;
END $$;

REVOKE EXECUTE ON FUNCTION otl.bug_read_owned(text,text,text,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.bug_claim_due_deliveries(jsonb) FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('022-bug-private-read');
COMMIT;
