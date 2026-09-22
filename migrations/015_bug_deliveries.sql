BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE otl.bug_deliveries (
  delivery_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_key text NOT NULL UNIQUE CHECK (length(delivery_key) BETWEEN 8 AND 512),
  delivery_kind text NOT NULL CHECK (delivery_kind IN ('question','summary','receipt','admin_handoff')),
  team_id text NOT NULL,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  packet_revision integer NOT NULL CHECK (packet_revision > 0),
  question_id text,
  destination text NOT NULL CHECK (destination IN ('reporter_thread','reporter_ephemeral','admin_channel')),
  template_id text NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
  field_name text CHECK (field_name IS NULL OR field_name IN ('actual','expected','steps','location','occurredAt','frequency','impact')),
  renderer_version text NOT NULL CHECK (length(renderer_version) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','sent','failed','cancelled')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
  retry_after timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code IN ('slack_api_error','rate_limited','auth_error','invalid_destination','timeout','network_error')),
  message_ts text,
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (bug_id,packet_revision,delivery_kind,destination),
  FOREIGN KEY (bug_id,question_id) REFERENCES otl.bug_questions(bug_id,question_id) ON DELETE CASCADE,
  CHECK (delivery_key=bug_id||':'||packet_revision::text||':'||delivery_kind||':'||destination),
  CHECK ((delivery_kind='question')=(question_id IS NOT NULL AND field_name IS NOT NULL)),
  CHECK ((status='claimed')=(worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status='sent')=(message_ts IS NOT NULL)),
  CHECK ((status='failed')=(last_error_code IS NOT NULL)),
  CHECK (retry_after IS NULL OR status='failed')
);

CREATE INDEX bug_deliveries_claimable ON otl.bug_deliveries(team_id,status,not_before,retry_after,delivery_id)
WHERE status IN ('pending','failed','claimed');

CREATE FUNCTION otl.bug_enqueue_delivery(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE report otl.bug_reports; question otl.bug_questions; revision otl.bug_report_revisions; delivery otl.bug_deliveries; kind text:=p->>'deliveryKind'; template text:=p->>'templateId'; expected_key text;
BEGIN
  IF jsonb_typeof(p)<>'object' OR coalesce(p->>'teamId','')='' OR coalesce(p->>'bugId','')=''
     OR coalesce(p->>'reporterId','')='' OR coalesce(p->>'deliveryKey','')=''
     OR kind NOT IN ('question','summary','receipt','admin_handoff')
     OR coalesce(p->>'destination','')='' OR coalesce(template,'')=''
     OR coalesce(p->>'rendererVersion','')='' THEN RAISE EXCEPTION 'invalid delivery enqueue' USING ERRCODE='22023'; END IF;
  expected_key:=(p->>'bugId')||':'||((p->>'packetRevision')::integer)::text||':'||kind||':'||(p->>'destination');
  IF p->>'deliveryKey'<>expected_key THEN RAISE EXCEPTION 'invalid delivery key' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p->>'deliveryKey',15));
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND OR report.team_id<>p->>'teamId' OR report.reporter_id<>p->>'reporterId' THEN RAISE EXCEPTION 'delivery owner denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO delivery FROM otl.bug_deliveries WHERE delivery_key=p->>'deliveryKey';
  IF FOUND THEN
    IF delivery.team_id<>p->>'teamId' OR delivery.bug_id<>report.bug_id OR delivery.delivery_kind<>kind OR delivery.destination<>p->>'destination' OR delivery.template_id<>template OR delivery.renderer_version<>p->>'rendererVersion' OR delivery.question_id IS DISTINCT FROM p->>'questionId' OR delivery.field_name IS DISTINCT FROM p->>'fieldName' THEN RAISE EXCEPTION 'delivery idempotency mismatch' USING ERRCODE='22023'; END IF;
    RETURN to_jsonb(delivery);
  END IF;
  IF kind='question' THEN
    IF coalesce(p->>'questionId','')='' OR coalesce(p->>'fieldName','')='' THEN RAISE EXCEPTION 'question delivery metadata required' USING ERRCODE='22023'; END IF;
    SELECT * INTO question FROM otl.bug_questions WHERE bug_id=report.bug_id AND question_id=p->>'questionId';
    IF NOT FOUND OR question.asked_packet_revision<>(p->>'packetRevision')::integer OR question.field_name<>p->>'fieldName' OR question.template_version<>template THEN RAISE EXCEPTION 'delivery question mismatch' USING ERRCODE='23514'; END IF;
    IF p->>'destination' NOT IN ('reporter_thread','reporter_ephemeral') THEN RAISE EXCEPTION 'question destination mismatch' USING ERRCODE='23514'; END IF;
  ELSE
    IF p ? 'questionId' OR p ? 'fieldName' THEN RAISE EXCEPTION 'non-question delivery rejects question metadata' USING ERRCODE='22023'; END IF;
    IF template NOT LIKE kind||'.%' THEN RAISE EXCEPTION 'delivery template kind mismatch' USING ERRCODE='23514'; END IF;
    IF report.packet_revision<>(p->>'packetRevision')::integer THEN RAISE EXCEPTION 'stale delivery revision' USING ERRCODE='40001'; END IF;
    SELECT * INTO revision FROM otl.bug_report_revisions WHERE bug_id=report.bug_id AND packet_revision=report.packet_revision;
    IF kind='summary' THEN
      IF report.state NOT IN ('new','needs_info') OR revision.sanitized_fields->>'actual' IS NULL OR revision.sanitized_fields->>'expected' IS NULL OR jsonb_array_length(revision.sanitized_fields->'steps')<2 OR revision.sanitized_fields->>'location' IS NULL OR revision.sanitized_fields->>'occurredAt' IS NULL OR revision.sanitized_fields->>'frequency' IS NULL OR revision.sanitized_fields->>'impact' IS NULL OR p->>'destination' NOT IN ('reporter_thread','reporter_ephemeral') THEN RAISE EXCEPTION 'summary delivery state mismatch' USING ERRCODE='23514'; END IF;
    ELSIF kind='receipt' THEN
      IF NOT ((report.state='triaged' AND revision.status='confirmed') OR report.state='rejected') OR p->>'destination' NOT IN ('reporter_thread','reporter_ephemeral') THEN RAISE EXCEPTION 'receipt delivery state mismatch' USING ERRCODE='23514'; END IF;
    ELSIF kind='admin_handoff' THEN
      IF report.state NOT IN ('private_incident','needs_info_exhausted') OR p->>'destination' NOT IN ('admin_channel','reporter_ephemeral') THEN RAISE EXCEPTION 'admin handoff delivery state mismatch' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  INSERT INTO otl.bug_deliveries(delivery_key,delivery_kind,team_id,bug_id,packet_revision,question_id,destination,template_id,field_name,renderer_version,not_before)
  VALUES(p->>'deliveryKey',kind,p->>'teamId',report.bug_id,(p->>'packetRevision')::integer,p->>'questionId',p->>'destination',template,p->>'fieldName',p->>'rendererVersion',coalesce((p->>'notBefore')::timestamptz,clock_timestamp())) RETURNING * INTO delivery;
  RETURN to_jsonb(delivery);
END $$;

CREATE FUNCTION otl.bug_claim_delivery(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE report otl.bug_reports; delivery otl.bug_deliveries; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
BEGIN
  IF coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')='' OR coalesce(p->>'deliveryKey','')='' OR lease_seconds NOT BETWEEN 30 AND 1800 THEN RAISE EXCEPTION 'invalid delivery claim' USING ERRCODE='22023'; END IF;
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p->>'bugId';
  IF NOT FOUND OR report.team_id<>p->>'teamId' OR report.reporter_id<>p->>'reporterId' THEN RAISE EXCEPTION 'delivery owner denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO delivery FROM otl.bug_deliveries WHERE delivery_key=p->>'deliveryKey' AND bug_id=report.bug_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown delivery' USING ERRCODE='22023'; END IF;
  IF delivery.status='claimed' AND delivery.worker_id=p->>'workerId' AND delivery.lease_token=p->>'leaseToken' AND delivery.lease_expires_at>=at_time THEN RETURN to_jsonb(delivery); END IF;
  IF delivery.status='claimed' AND delivery.attempts>=3 AND delivery.lease_expires_at<at_time THEN
    UPDATE otl.bug_deliveries SET status='failed',last_error_code='timeout',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id;
    RETURN 'null'::jsonb;
  END IF;
  IF NOT ((delivery.status='pending' AND delivery.not_before<=at_time)
    OR (delivery.status='failed' AND delivery.attempts<3 AND delivery.retry_after<=at_time)
    OR (delivery.status='claimed' AND delivery.attempts<3 AND delivery.lease_expires_at<at_time)) THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.bug_deliveries SET status='claimed',attempts=attempts+1,worker_id=p->>'workerId',lease_token=p->>'leaseToken',lease_expires_at=at_time+make_interval(secs=>lease_seconds),retry_after=NULL,last_error_code=NULL,message_ts=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id RETURNING * INTO delivery;
  RETURN to_jsonb(delivery);
END $$;

CREATE FUNCTION otl.bug_finish_delivery(p jsonb) RETURNS jsonb
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
    IF p->>'errorCode' NOT IN ('slack_api_error','rate_limited','auth_error','invalid_destination','timeout','network_error') THEN RAISE EXCEPTION 'invalid delivery error code' USING ERRCODE='22023'; END IF;
    retry_time:=CASE WHEN delivery.attempts<3 THEN (p->>'retryAfter')::timestamptz END;
    IF delivery.attempts<3 AND (retry_time IS NULL OR retry_time<=at_time) THEN RAISE EXCEPTION 'future retry required' USING ERRCODE='22023'; END IF;
    UPDATE otl.bug_deliveries SET status='failed',retry_after=retry_time,last_error_code=p->>'errorCode',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=at_time WHERE delivery_id=delivery.delivery_id RETURNING * INTO delivery;
  ELSE
    RAISE EXCEPTION 'invalid delivery finish status' USING ERRCODE='22023';
  END IF;
  RETURN to_jsonb(delivery);
END $$;

CREATE FUNCTION otl.bug_get_delivery(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,otl AS $$
DECLARE report otl.bug_reports; delivery otl.bug_deliveries;
BEGIN
  SELECT * INTO report FROM otl.bug_reports WHERE bug_id=p->>'bugId';
  IF NOT FOUND OR report.team_id<>p->>'teamId' OR report.reporter_id<>p->>'reporterId' THEN RAISE EXCEPTION 'delivery owner denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO delivery FROM otl.bug_deliveries WHERE delivery_key=p->>'deliveryKey' AND bug_id=report.bug_id;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  RETURN to_jsonb(delivery);
END $$;

REVOKE ALL ON otl.bug_deliveries FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.bug_enqueue_delivery(jsonb),otl.bug_claim_delivery(jsonb),otl.bug_finish_delivery(jsonb),otl.bug_get_delivery(jsonb) FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('015-bug-deliveries');
COMMIT;
