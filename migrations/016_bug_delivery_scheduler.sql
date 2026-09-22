BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE otl.bug_deliveries DROP CONSTRAINT bug_deliveries_last_error_code_check;
ALTER TABLE otl.bug_deliveries ADD CONSTRAINT bug_deliveries_last_error_code_check
CHECK (last_error_code IS NULL OR last_error_code IN (
  'slack_api_error','rate_limited','auth_error','invalid_destination','timeout','network_error',
  'invalid_payload','provider_error'
));

CREATE FUNCTION otl.bug_claim_due_deliveries(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
  batch_limit integer:=coalesce((p->>'limit')::integer,10);
  result jsonb;
BEGIN
  IF coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')=''
     OR lease_seconds NOT BETWEEN 30 AND 1800 OR batch_limit NOT BETWEEN 1 AND 25
  THEN RAISE EXCEPTION 'invalid due delivery claim' USING ERRCODE='22023'; END IF;
  UPDATE otl.bug_deliveries SET
    status='failed',retry_after=NULL,last_error_code='timeout',worker_id=NULL,
    lease_token=NULL,lease_expires_at=NULL,updated_at=at_time
  WHERE status='claimed' AND attempts>=3 AND lease_expires_at<at_time;
  WITH due AS (
    SELECT d.delivery_id
    FROM otl.bug_deliveries d JOIN otl.bug_reports r ON r.bug_id=d.bug_id
    WHERE r.source='slack' AND r.source_channel_id IS NOT NULL AND r.source_thread IS NOT NULL
      AND d.attempts<3 AND (
      (d.status='pending' AND d.not_before<=at_time) OR
      (d.status='failed' AND d.retry_after<=at_time) OR
      (d.status='claimed' AND d.lease_expires_at<at_time)
    )
    ORDER BY coalesce(d.retry_after,d.not_before),d.delivery_id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_limit
  ), claimed AS (
    UPDATE otl.bug_deliveries d SET
      status='claimed',attempts=d.attempts+1,worker_id=p->>'workerId',
      lease_token=p->>'leaseToken',lease_expires_at=at_time+make_interval(secs=>lease_seconds),
      retry_after=NULL,last_error_code=NULL,message_ts=NULL,updated_at=at_time
    FROM due WHERE d.delivery_id=due.delivery_id
    RETURNING d.*
  )
  SELECT coalesce(jsonb_agg(
    to_jsonb(claimed)||jsonb_build_object(
      'reporter_id',r.reporter_id,
      'source_channel_id',r.source_channel_id,
      'source_thread',r.source_thread,
      'report_revision',r.revision,
      'sanitized_fields',rev.sanitized_fields
    ) ORDER BY claimed.delivery_id
  ),'[]'::jsonb) INTO result
  FROM claimed
  JOIN otl.bug_reports r ON r.bug_id=claimed.bug_id
  JOIN otl.bug_report_revisions rev
    ON rev.bug_id=claimed.bug_id AND rev.packet_revision=claimed.packet_revision;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION otl.bug_finish_delivery(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE report otl.bug_reports; delivery otl.bug_deliveries; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); target_status text:=p->>'status'; retry_time timestamptz;
BEGIN
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p->>'bugId';
  IF NOT FOUND OR report.team_id<>p->>'teamId' OR report.reporter_id<>p->>'reporterId' THEN RAISE EXCEPTION 'delivery owner denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO delivery FROM otl.bug_deliveries WHERE delivery_id=(p->>'deliveryId')::bigint AND bug_id=report.bug_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown delivery' USING ERRCODE='22023'; END IF;
  IF delivery.status='sent' AND target_status='sent' AND delivery.message_ts=p->>'messageTs' THEN RETURN to_jsonb(delivery); END IF;
  IF delivery.status='failed' AND target_status='failed' AND delivery.last_error_code=p->>'errorCode' THEN RETURN to_jsonb(delivery); END IF;
  IF delivery.status<>'claimed' OR delivery.worker_id<>p->>'workerId' OR delivery.lease_token<>p->>'leaseToken' OR delivery.lease_expires_at<at_time THEN RAISE EXCEPTION 'delivery lease lost' USING ERRCODE='40001'; END IF;
  IF target_status='sent' THEN
    IF coalesce(p->>'messageTs','')='' THEN RAISE EXCEPTION 'message timestamp required' USING ERRCODE='22023'; END IF;
    UPDATE otl.bug_deliveries SET status='sent',message_ts=p->>'messageTs',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id RETURNING * INTO delivery;
  ELSIF target_status='failed' THEN
    IF p->>'errorCode' NOT IN ('slack_api_error','rate_limited','auth_error','invalid_destination','timeout','network_error','invalid_payload','provider_error') THEN RAISE EXCEPTION 'invalid delivery error code' USING ERRCODE='22023'; END IF;
    retry_time:=CASE WHEN delivery.attempts<3 THEN (p->>'retryAfter')::timestamptz END;
    IF delivery.attempts<3 AND (retry_time IS NULL OR retry_time<=at_time) THEN RAISE EXCEPTION 'future retry required' USING ERRCODE='22023'; END IF;
    UPDATE otl.bug_deliveries SET status='failed',retry_after=retry_time,last_error_code=p->>'errorCode',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id RETURNING * INTO delivery;
  ELSE
    RAISE EXCEPTION 'invalid delivery finish status' USING ERRCODE='22023';
  END IF;
  RETURN to_jsonb(delivery);
END $$;

REVOKE EXECUTE ON FUNCTION otl.bug_claim_due_deliveries(jsonb) FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('016-bug-delivery-scheduler');
COMMIT;
