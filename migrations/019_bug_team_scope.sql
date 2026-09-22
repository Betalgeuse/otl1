BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP INDEX otl.bug_deliveries_global_due;
CREATE INDEX bug_deliveries_global_due ON otl.bug_deliveries(
  team_id,
  status,
  (CASE
    WHEN status='failed' THEN retry_after
    WHEN status='claimed' THEN lease_expires_at
    ELSE not_before
  END),
  delivery_id
) WHERE status IN ('pending','failed','claimed');

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
          WHERE bug_id=claimed.bug_id AND packet_revision=claimed.packet_revision)
      )
    );
    claimed_count:=claimed_count+1;
  END LOOP;
  RETURN result;
END $$;

INSERT INTO otl.schema_migrations(version) VALUES('019-bug-team-scope');
COMMIT;
