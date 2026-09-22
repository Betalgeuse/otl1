BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION otl.bug_commit_private(
  p_bug_id text,
  p_event_key text,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE report otl.bug_reports; object_digest text;
BEGIN
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p_bug_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown private bug' USING ERRCODE='22023'; END IF;
  SELECT rev.object_digest INTO STRICT object_digest FROM otl.bug_report_revisions rev
  WHERE rev.bug_id=report.bug_id AND rev.packet_revision=report.packet_revision;
  IF report.state<>'private_incident' THEN
    IF report.state NOT IN ('new','needs_info') THEN
      RAISE EXCEPTION 'private classification state conflict' USING ERRCODE='40001';
    END IF;
    INSERT INTO otl.bug_events(
      bug_id,idempotency_key,from_state,to_state,variant,revision,
      actors,guard_code,evidence,occurred_at
    ) VALUES(
      report.bug_id,p_event_key,report.state,'private_incident','',report.revision+1,
      '["deterministic_worker"]'::jsonb,'private',jsonb_build_object('intakeDigest',object_digest),p_now
    ) ON CONFLICT (bug_id,idempotency_key) DO NOTHING;
    UPDATE otl.bug_reports SET
      state='private_incident',revision=revision+1,privacy=true,
      public_export_enabled=false,updated_at=p_now
    WHERE bug_id=report.bug_id AND state=report.state AND revision=report.revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'private classification race' USING ERRCODE='40001'; END IF;
  END IF;
  UPDATE otl.bug_deliveries SET
    status='cancelled',cancel_reason='obsolete_state',worker_id=NULL,lease_token=NULL,
    lease_expires_at=NULL,retry_after=NULL,last_error_code=NULL,updated_at=p_now
  WHERE bug_id=report.bug_id AND status IN ('pending','failed','claimed')
    AND NOT (
      packet_revision=report.packet_revision
      AND ((delivery_kind='receipt' AND destination='reporter_ephemeral'
        AND template_id='receipt.private.v1')
        OR (delivery_kind='admin_handoff' AND destination='admin_channel'
          AND template_id='admin_handoff.private.v1'))
    );
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,destination,
    template_id,renderer_version,not_before
  ) VALUES
    (report.bug_id||':'||report.packet_revision||':receipt:reporter_ephemeral',
     'receipt',report.team_id,report.bug_id,report.packet_revision,'reporter_ephemeral',
     'receipt.private.v1','bug-receipt.v1',p_now),
    (report.bug_id||':'||report.packet_revision||':admin_handoff:admin_channel',
     'admin_handoff',report.team_id,report.bug_id,report.packet_revision,'admin_channel',
     'admin_handoff.private.v1','bug-handoff.v1',p_now)
  ON CONFLICT (bug_id,packet_revision,delivery_kind,destination) DO NOTHING;
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=report.bug_id;
  RETURN to_jsonb(report);
END $$;

CREATE FUNCTION otl.bug_create_draft_atomic(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE report jsonb; private_requested boolean:=coalesce((p#>>'{sanitizedFields,privacy}')::boolean,false);
BEGIN
  SELECT otl.bug_create_draft(p) INTO report;
  IF private_requested OR coalesce((report->>'privacy')::boolean,false) THEN
    RETURN otl.bug_commit_private(report->>'bug_id','atomic:private:draft:'||(p->>'idempotencyKey'));
  END IF;
  RETURN report;
END $$;

CREATE FUNCTION otl.bug_answer_revision_atomic(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE revision jsonb; report otl.bug_reports; private_requested boolean;
BEGIN
  private_requested:=coalesce((p->>'privacy')::boolean,false)
    OR p#>>'{sanitizedFields,impact}'='security_privacy';
  SELECT otl.bug_answer_revision(p) INTO revision;
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p->>'bugId';
  IF private_requested OR report.privacy THEN
    PERFORM otl.bug_commit_private(report.bug_id,'atomic:private:answer:'||(p->>'idempotencyKey'));
  END IF;
  RETURN revision;
END $$;

CREATE FUNCTION otl.bug_reconcile_private_incidents(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  team text:=p->>'teamId';
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  batch_limit integer:=coalesce((p->>'limit')::integer,10);
  report record;
  reconciled integer:=0;
BEGIN
  IF coalesce(team,'') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
     OR batch_limit NOT BETWEEN 1 AND 25
  THEN RAISE EXCEPTION 'invalid private reconciliation' USING ERRCODE='22023'; END IF;
  FOR report IN
    SELECT r.bug_id,r.packet_revision
    FROM otl.bug_reports r
    JOIN otl.bug_report_revisions rev
      ON rev.bug_id=r.bug_id AND rev.packet_revision=r.packet_revision
    WHERE r.team_id=team AND (
      (r.state IN ('new','needs_info') AND (
        r.privacy OR r.impact='security_privacy'
        OR coalesce((rev.sanitized_fields->>'privacy')::boolean,false)
        OR rev.sanitized_fields->>'impact'='security_privacy'
      ))
      OR (r.state='private_incident' AND (
        NOT EXISTS(SELECT 1 FROM otl.bug_deliveries d WHERE d.bug_id=r.bug_id
          AND d.packet_revision=r.packet_revision AND d.delivery_kind='receipt'
          AND d.destination='reporter_ephemeral')
        OR NOT EXISTS(SELECT 1 FROM otl.bug_deliveries d WHERE d.bug_id=r.bug_id
          AND d.packet_revision=r.packet_revision AND d.delivery_kind='admin_handoff'
          AND d.destination='admin_channel')
      ))
    )
    ORDER BY r.created_at,r.bug_id
    FOR UPDATE OF r SKIP LOCKED
    LIMIT batch_limit
  LOOP
    PERFORM otl.bug_commit_private(
      report.bug_id,'system:private-reconcile:'||report.packet_revision,at_time
    );
    reconciled:=reconciled+1;
  END LOOP;
  RETURN to_jsonb(reconciled);
END $$;

CREATE OR REPLACE FUNCTION otl.bug_claim_delivery(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  report otl.bug_reports;
  delivery otl.bug_deliveries;
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
  obsolete_reason text;
BEGIN
  IF coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')=''
     OR coalesce(p->>'deliveryKey','')='' OR lease_seconds NOT BETWEEN 30 AND 1800
  THEN RAISE EXCEPTION 'invalid delivery claim' USING ERRCODE='22023'; END IF;
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND OR report.team_id<>p->>'teamId' OR report.reporter_id<>p->>'reporterId'
  THEN RAISE EXCEPTION 'delivery owner denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO delivery FROM otl.bug_deliveries
  WHERE delivery_key=p->>'deliveryKey' AND bug_id=report.bug_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown delivery' USING ERRCODE='22023'; END IF;
  IF delivery.delivery_kind='question' THEN
    PERFORM 1 FROM otl.bug_questions q
    WHERE q.bug_id=delivery.bug_id AND q.question_id=delivery.question_id FOR UPDATE;
  END IF;
  IF delivery.status='claimed' AND delivery.worker_id=p->>'workerId'
     AND delivery.lease_token=p->>'leaseToken' AND delivery.lease_expires_at>=at_time
  THEN RETURN to_jsonb(delivery); END IF;
  IF delivery.status IN ('sent','cancelled') THEN RETURN 'null'::jsonb; END IF;
  obsolete_reason:=CASE
    WHEN report.packet_revision<>delivery.packet_revision THEN 'obsolete_revision'
    WHEN delivery.delivery_kind='question' AND NOT EXISTS(
      SELECT 1 FROM otl.bug_questions q WHERE q.bug_id=delivery.bug_id
        AND q.question_id=delivery.question_id AND q.answer_digest IS NULL
    ) THEN 'obsolete_question'
    WHEN delivery.delivery_kind='question' AND report.state<>'needs_info' THEN 'obsolete_state'
    WHEN delivery.delivery_kind='summary' AND report.state NOT IN ('new','needs_info') THEN 'obsolete_state'
    WHEN delivery.delivery_kind='receipt' AND NOT (
      report.state='rejected' OR report.state='needs_info_exhausted'
      OR (report.state='private_incident' AND delivery.template_id='receipt.private.v1')
      OR (report.state='triaged' AND EXISTS(
        SELECT 1 FROM otl.bug_report_revisions rev WHERE rev.bug_id=delivery.bug_id
          AND rev.packet_revision=delivery.packet_revision AND rev.status='confirmed'))
    ) THEN 'obsolete_state'
    WHEN delivery.delivery_kind='admin_handoff'
      AND report.state NOT IN ('private_incident','needs_info_exhausted') THEN 'obsolete_state'
  END;
  IF obsolete_reason IS NOT NULL THEN
    UPDATE otl.bug_deliveries SET status='cancelled',cancel_reason=obsolete_reason,
      worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,
      last_error_code=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id;
    RETURN 'null'::jsonb;
  END IF;
  IF delivery.status='claimed' AND delivery.attempts>=3 AND delivery.lease_expires_at<at_time THEN
    UPDATE otl.bug_deliveries SET status='failed',last_error_code='timeout',worker_id=NULL,
      lease_token=NULL,lease_expires_at=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id;
    RETURN 'null'::jsonb;
  END IF;
  IF NOT ((delivery.status='pending' AND delivery.not_before<=at_time)
    OR (delivery.status='failed' AND delivery.attempts<3 AND delivery.retry_after<=at_time)
    OR (delivery.status='claimed' AND delivery.attempts<3 AND delivery.lease_expires_at<at_time))
  THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.bug_deliveries SET
    status='claimed',attempts=attempts+1,worker_id=p->>'workerId',lease_token=p->>'leaseToken',
    lease_expires_at=at_time+make_interval(secs=>lease_seconds),retry_after=NULL,
    last_error_code=NULL,message_ts=NULL,cancel_reason=NULL,updated_at=at_time
  WHERE delivery_id=delivery.delivery_id RETURNING * INTO delivery;
  RETURN to_jsonb(delivery);
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
          WHERE bug_id=claimed.bug_id AND packet_revision=claimed.packet_revision)
      )
    );
    claimed_count:=claimed_count+1;
  END LOOP;
  RETURN result;
END $$;

REVOKE EXECUTE ON FUNCTION
  otl.bug_commit_private(text,text,timestamptz),otl.bug_create_draft_atomic(jsonb),
  otl.bug_answer_revision_atomic(jsonb),otl.bug_reconcile_private_incidents(jsonb)
FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('020-bug-private-atomic');
COMMIT;
