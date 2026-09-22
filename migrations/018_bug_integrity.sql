BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

ALTER TABLE otl.bug_report_revisions
  ADD COLUMN evidence_object_digest text
  CHECK (evidence_object_digest IS NULL OR evidence_object_digest ~ '^[0-9a-f]{64}$');

ALTER TABLE otl.bug_jobs
  ADD COLUMN finished_worker_id text,
  ADD COLUMN finished_lease_token text,
  ADD COLUMN finished_lease_expires_at timestamptz;

ALTER TABLE otl.bug_deliveries
  ADD COLUMN cancel_reason text
  CHECK (cancel_reason IS NULL OR cancel_reason IN ('obsolete_question','obsolete_revision','obsolete_state'));

UPDATE otl.bug_deliveries SET cancel_reason='obsolete_state' WHERE status='cancelled';

ALTER TABLE otl.bug_deliveries
  ADD CONSTRAINT bug_deliveries_cancel_reason_state_check
  CHECK ((status='cancelled')=(cancel_reason IS NOT NULL));

CREATE INDEX bug_deliveries_global_due ON otl.bug_deliveries(
  status,
  (CASE
    WHEN status='failed' THEN retry_after
    WHEN status='claimed' THEN lease_expires_at
    ELSE not_before
  END),
  delivery_id
) WHERE status IN ('pending','failed','claimed');

CREATE FUNCTION otl.bug_canonical_json(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,otl AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN coalesce((
      SELECT '{'||string_agg(to_jsonb(key)::text||':'||otl.bug_canonical_json(item),',' ORDER BY key)||'}'
      FROM jsonb_each(value) AS member(key,item)
    ),'{}')
    WHEN 'array' THEN coalesce((
      SELECT '['||string_agg(otl.bug_canonical_json(item),',' ORDER BY ordinal)||']'
      FROM jsonb_array_elements(value) WITH ORDINALITY AS member(item,ordinal)
    ),'[]')
    ELSE value::text
  END
$$;

CREATE OR REPLACE FUNCTION otl.bug_confirm_packet(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  r otl.bug_reports;
  next_revision integer;
  claimed_revision integer;
  claimed_operation text;
  packet jsonb:=p->'packet';
  storage jsonb:=p->'storage';
  f jsonb:=packet->'fields';
  confirmation jsonb:=packet->'confirmation';
  source_metadata jsonb:=packet->'source';
  canonical_text text:=storage->>'canonicalPacket';
  canonical_evidence_text text:=storage->>'canonicalEvidence';
  canonical_packet jsonb;
  canonical_evidence jsonb;
  unsigned_packet jsonb;
  computed_digest text;
  rev otl.bug_report_revisions;
BEGIN
  IF jsonb_typeof(packet)<>'object' OR jsonb_typeof(storage)<>'object'
     OR coalesce(storage->>'idempotencyKey','')='' OR coalesce(canonical_text,'')=''
     OR coalesce(canonical_evidence_text,'')=''
  THEN RAISE EXCEPTION 'confirmation envelope required' USING ERRCODE='22023'; END IF;
  BEGIN
    canonical_packet:=canonical_text::jsonb;
    canonical_evidence:=canonical_evidence_text::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid canonical packet' USING ERRCODE='22023';
  END;
  unsigned_packet:=packet-'packetDigest';
  computed_digest:=encode(public.digest(convert_to(canonical_text,'UTF8'),'sha256'),'hex');
  IF canonical_packet<>unsigned_packet OR canonical_text<>otl.bug_canonical_json(unsigned_packet)
     OR computed_digest IS DISTINCT FROM packet->>'packetDigest'
     OR jsonb_typeof(canonical_evidence)<>'array'
     OR canonical_evidence_text<>otl.bug_canonical_json(canonical_evidence)
     OR encode(public.digest(convert_to(canonical_evidence_text,'UTF8'),'sha256'),'hex')
       IS DISTINCT FROM packet->>'evidenceDigest'
     OR coalesce(storage->>'evidenceObjectDigest','') !~ '^[0-9a-f]{64}$'
     OR storage->>'evidenceObjectDigest' IS DISTINCT FROM storage->>'objectDigest'
  THEN RAISE EXCEPTION 'invalid confirmed packet binding' USING ERRCODE='22023'; END IF;

  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=packet->>'bugId' FOR UPDATE;
  SELECT packet_revision,operation INTO claimed_revision,claimed_operation
  FROM otl.bug_revision_claims
  WHERE bug_id=packet->>'bugId' AND idempotency_key=storage->>'idempotencyKey';
  IF FOUND THEN
    IF claimed_operation<>'confirm' THEN RAISE EXCEPTION 'idempotency operation mismatch' USING ERRCODE='22023'; END IF;
    SELECT * INTO rev FROM otl.bug_report_revisions
    WHERE bug_id=packet->>'bugId' AND packet_revision=claimed_revision;
    IF rev.confirmed_packet IS DISTINCT FROM packet
       OR rev.opaque_ref IS DISTINCT FROM storage->>'opaqueRef'
       OR rev.object_digest IS DISTINCT FROM storage->>'objectDigest'
       OR rev.evidence_object_digest IS DISTINCT FROM storage->>'evidenceObjectDigest'
    THEN RAISE EXCEPTION 'confirmation idempotency mismatch' USING ERRCODE='22023'; END IF;
    RETURN rev.confirmed_packet;
  END IF;
  next_revision:=r.packet_revision+1;
  IF r.bug_id IS NULL OR r.team_id<>storage->>'teamId' OR r.reporter_id<>storage->>'reporterId'
     OR r.packet_revision<>(storage->>'expectedPacketRevision')::integer
     OR packet->>'schemaVersion'<>'bug_packet.v1' OR packet->>'status'<>'confirmed'
     OR coalesce((confirmation->>'reporterConfirmed')::boolean,false) IS NOT TRUE
     OR packet->>'bugId'<>r.bug_id OR source_metadata->>'opaqueRef'<>r.source_opaque_ref
     OR jsonb_typeof(packet->'revision')<>'number' OR (packet->>'revision')::integer<>next_revision
     OR coalesce(packet->>'packetDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(packet->>'evidenceDigest','') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(f)<>'object'
     OR NOT (f ?& ARRAY['actual','expected','steps','location','occurredAt','frequency','impact'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['actual','expected','steps','location','occurredAt','frequency','impact']))
     OR jsonb_typeof(f->'actual')<>'string' OR jsonb_typeof(f->'expected')<>'string'
     OR jsonb_typeof(f->'location')<>'string' OR jsonb_typeof(f->'occurredAt')<>'string'
     OR f->>'frequency' NOT IN ('always','sometimes','once')
     OR f->>'impact' NOT IN ('inconvenience','blocked','wrong_data','security_privacy')
     OR jsonb_typeof(f->'steps')<>'array' OR jsonb_array_length(f->'steps') NOT BETWEEN 2 AND 50
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(f->'steps') step WHERE jsonb_typeof(step)<>'string')
     OR jsonb_typeof(confirmation)<>'object'
     OR NOT (confirmation ?& ARRAY['reporterConfirmed','confirmedAt'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(confirmation) k WHERE NOT k=ANY(ARRAY['reporterConfirmed','confirmedAt']))
     OR jsonb_typeof(source_metadata)<>'object' OR NOT (source_metadata ?& ARRAY['kind','opaqueRef'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(source_metadata) k WHERE NOT k=ANY(ARRAY['kind','opaqueRef']))
     OR coalesce(source_metadata->>'kind','')='' OR coalesce(confirmation->>'confirmedAt','')=''
     OR coalesce(storage->>'opaqueRef','')=''
     OR coalesce(storage->>'objectDigest','') !~ '^[0-9a-f]{64}$'
     OR NOT (packet ?& ARRAY['schemaVersion','bugId','status','revision','fields','confirmation','source','evidenceDigest','packetDigest'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(packet) k WHERE NOT k=ANY(ARRAY['schemaVersion','bugId','status','revision','fields','confirmation','source','evidenceDigest','packetDigest']))
  THEN RAISE EXCEPTION 'invalid confirmed packet' USING ERRCODE='22023'; END IF;
  INSERT INTO otl.bug_report_revisions(
    bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,
    envelope_dek,kek_version,nonce,evidence_digest,evidence_object_digest,packet_digest,
    reporter_confirmed,confirmed_at,confirmed_packet
  ) VALUES(
    r.bug_id,next_revision,'bug_packet.v1','confirmed',f,storage->>'opaqueRef',storage->>'objectDigest',
    storage->>'envelopeDek',storage->>'kekVersion',storage->>'nonce',packet->>'evidenceDigest',
    storage->>'evidenceObjectDigest',packet->>'packetDigest',true,
    (confirmation->>'confirmedAt')::timestamptz,packet
  ) RETURNING * INTO rev;
  UPDATE otl.bug_reports SET
    packet_revision=next_revision,confirmed_packet_digest=packet->>'packetDigest',
    confirmed_evidence_digest=packet->>'evidenceDigest',actual=f->>'actual',expected=f->>'expected',
    steps=f->'steps',location=f->>'location',occurred_at=(f->>'occurredAt')::timestamptz,
    frequency=f->>'frequency',impact=f->>'impact',updated_at=clock_timestamp()
  WHERE bug_id=r.bug_id;
  INSERT INTO otl.bug_revision_claims VALUES(r.bug_id,storage->>'idempotencyKey','confirm',next_revision);
  RETURN packet;
END $$;

CREATE OR REPLACE FUNCTION otl.bug_lease_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  j otl.bug_jobs;
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
BEGIN
  IF coalesce(p->>'workerId','')='' OR coalesce(p->>'accountAlias','')=''
     OR coalesce(p->>'leaseToken','')='' OR lease_seconds NOT BETWEEN 30 AND 1800
     OR jsonb_typeof(p->'kinds')<>'array'
  THEN RAISE EXCEPTION 'invalid lease' USING ERRCODE='22023'; END IF;
  SELECT * INTO j FROM otl.bug_jobs
  WHERE status='leased' AND worker_id=p->>'workerId' AND lease_token=p->>'leaseToken'
    AND lease_expires_at>=at_time;
  IF FOUND THEN RETURN to_jsonb(j); END IF;
  UPDATE otl.bug_jobs SET
    status=CASE WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,
    finished_at=CASE WHEN attempt>=3 THEN at_time END,
    worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=at_time
  WHERE status='leased' AND lease_expires_at<at_time;
  SELECT * INTO j FROM otl.bug_jobs
  WHERE status='queued' AND available_at<=at_time
    AND kind IN (SELECT jsonb_array_elements_text(p->'kinds'))
    AND (assigned_alias IS NULL OR assigned_alias=p->>'accountAlias')
  ORDER BY priority,available_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.bug_jobs SET
    status='leased',worker_id=p->>'workerId',assigned_alias=p->>'accountAlias',
    lease_token=p->>'leaseToken',lease_expires_at=at_time+make_interval(secs=>lease_seconds),
    heartbeat_at=at_time,attempt=attempt+1,updated_at=at_time
  WHERE job_id=j.job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END $$;

CREATE OR REPLACE FUNCTION otl.bug_finish_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  SELECT * INTO j FROM otl.bug_jobs WHERE job_id=(p->>'jobId')::bigint FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown job' USING ERRCODE='22023'; END IF;
  IF j.status IN ('succeeded','failed') AND j.result_digest=p->>'resultDigest'
     AND j.finished_worker_id=p->>'workerId' AND j.finished_lease_token=p->>'leaseToken'
     AND j.finished_lease_expires_at>=at_time
  THEN RETURN to_jsonb(j); END IF;
  IF j.status<>'leased' OR j.worker_id<>p->>'workerId' OR j.lease_token<>p->>'leaseToken'
     OR j.lease_expires_at<at_time OR coalesce(p->>'resultDigest','') !~ '^[0-9a-f]{64}$'
     OR p->>'status' NOT IN ('succeeded','failed')
  THEN RAISE EXCEPTION 'finish conflict' USING ERRCODE='40001'; END IF;
  UPDATE otl.bug_jobs SET
    status=p->>'status',result_digest=p->>'resultDigest',finished_at=at_time,
    finished_worker_id=worker_id,finished_lease_token=lease_token,
    finished_lease_expires_at=lease_expires_at,
    lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=at_time
  WHERE job_id=j.job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_integrity_before_report_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF OLD.state='needs_info_exhausted' AND NEW.state='needs_info'
     AND NEW.needs_info_reset_count=OLD.needs_info_reset_count+1
  THEN NEW.question_count:=1; END IF;
  IF NEW.state='private_incident' AND OLD.state<>'private_incident' THEN
    NEW.title:='[private incident]';
    NEW.actual:=NULL;
    NEW.expected:=NULL;
    NEW.steps:='[]'::jsonb;
    NEW.location:=NULL;
    NEW.deployed_version:=NULL;
    UPDATE otl.bug_report_revisions SET
      sanitized_fields=jsonb_build_object('privacy',true,'objectDigest',object_digest),
      confirmed_packet=CASE WHEN confirmed_packet IS NULL THEN NULL
        ELSE jsonb_build_object('privacy',true,'packetDigest',packet_digest,'evidenceDigest',evidence_digest) END
    WHERE bug_id=OLD.bug_id;
    UPDATE otl.bug_questions SET
      question_text='[private question]',
      completeness=CASE WHEN completeness IS NULL THEN NULL ELSE '{"privacy":true}'::jsonb END
    WHERE bug_id=OLD.bug_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bug_integrity_before_report_update
BEFORE UPDATE ON otl.bug_reports
FOR EACH ROW EXECUTE FUNCTION otl.bug_integrity_before_report_update();

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
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
  batch_limit integer:=coalesce((p->>'limit')::integer,10);
  route record;
  claimed otl.bug_deliveries;
  obsolete_reason text;
  result jsonb:='[]'::jsonb;
  claimed_count integer:=0;
BEGIN
  IF coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')=''
     OR lease_seconds NOT BETWEEN 30 AND 1800 OR batch_limit NOT BETWEEN 1 AND 25
  THEN RAISE EXCEPTION 'invalid due delivery claim' USING ERRCODE='22023'; END IF;
  UPDATE otl.bug_deliveries SET
    status='failed',retry_after=NULL,last_error_code='timeout',worker_id=NULL,
    lease_token=NULL,lease_expires_at=NULL,updated_at=at_time
  WHERE status='claimed' AND attempts>=3 AND lease_expires_at<at_time;
  FOR route IN
    SELECT d.delivery_id,r.bug_id,r.team_id,r.reporter_id,r.state,r.packet_revision,
      r.source_channel_id,r.source_thread
    FROM otl.bug_deliveries d JOIN otl.bug_reports r ON r.bug_id=d.bug_id
    WHERE r.source='slack' AND r.source_channel_id IS NOT NULL AND r.source_thread IS NOT NULL
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
    SELECT * INTO claimed FROM otl.bug_deliveries WHERE delivery_id=route.delivery_id;
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
        last_error_code=NULL,updated_at=at_time WHERE delivery_id=claimed.delivery_id;
      CONTINUE;
    END IF;
    UPDATE otl.bug_deliveries SET
      status='claimed',attempts=attempts+1,worker_id=p->>'workerId',lease_token=p->>'leaseToken',
      lease_expires_at=at_time+make_interval(secs=>lease_seconds),retry_after=NULL,
      last_error_code=NULL,message_ts=NULL,cancel_reason=NULL,updated_at=at_time
    WHERE delivery_id=claimed.delivery_id RETURNING * INTO claimed;
    result:=result||jsonb_build_array(
      to_jsonb(claimed)||jsonb_build_object(
        'reporter_id',route.reporter_id,'source_channel_id',route.source_channel_id,
        'source_thread',route.source_thread,'report_revision',(
          SELECT revision FROM otl.bug_reports WHERE bug_id=route.bug_id),
        'sanitized_fields',(
          SELECT sanitized_fields FROM otl.bug_report_revisions
          WHERE bug_id=claimed.bug_id AND packet_revision=claimed.packet_revision)
      )
    );
    claimed_count:=claimed_count+1;
  END LOOP;
  RETURN result;
END $$;

REVOKE EXECUTE ON FUNCTION otl.bug_canonical_json(jsonb),otl.bug_integrity_before_report_update() FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('018-bug-integrity');
COMMIT;
