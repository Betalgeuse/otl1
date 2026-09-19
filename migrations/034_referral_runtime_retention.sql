BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:referral-runtime-retention:034',0));

CREATE OR REPLACE FUNCTION otl.referral_audit_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('otl.referral_retention',true)='enabled' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'referral audit rows are immutable';
END $$;

CREATE FUNCTION otl.referral_retention_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; now_at timestamptz; batch integer;
  processed integer:=0; remaining boolean:=false; due_at timestamptz;
  request otl.referral_requests;
BEGIN
  IF coalesce(t,'')='' OR coalesce(p->>'now','')='' THEN
    RAISE EXCEPTION 'retention scope and clock required';
  END IF;
  now_at:=(p->>'now')::timestamptz;
  batch:=least(greatest(coalesce((p->>'limit')::integer,10),1),10);
  IF op='next_due' THEN
    SELECT least(
      (SELECT min(payload_purge_after) FROM otl.referral_requests
        WHERE team_id=t AND state IN ('pending','approved')),
      (SELECT min(audit_purge_after) FROM otl.referral_request_events WHERE team_id=t),
      (SELECT min((body->>'expiresAt')::timestamptz) FROM otl.community_records
        WHERE team_id=t AND kind='referral_service_nonce'
          AND record_key LIKE 'referral-service-nonce:%')
    ) INTO due_at;
    RETURN jsonb_build_object('nextDue',due_at);
  END IF;
  IF op='expire_due' THEN
    FOR request IN SELECT * FROM otl.referral_requests
      WHERE team_id=t AND state IN ('pending','approved') AND payload_purge_after<=now_at
      ORDER BY payload_purge_after,request_id LIMIT batch FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE otl.referral_requests SET state='expired',revision=revision+1,terminal_at=now_at
        WHERE team_id=t AND request_id=request.request_id;
      UPDATE otl.referral_outbox SET status='cancelled'
        WHERE team_id=t AND request_id=request.request_id
          AND effect_type='admin_review' AND status IN ('pending','failed');
      INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
        from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
      VALUES(t,request.request_id,'retention-expire:'||request.revision,'expired','retention',
        request.state,'expired',md5(request.request_id||':'||request.revision),now_at,
        now_at+interval '12 months',jsonb_build_object('requestId',request.request_id,'state','expired'))
      ON CONFLICT(team_id,request_id,event_key) DO NOTHING;
      processed:=processed+1;
    END LOOP;
    SELECT EXISTS(SELECT 1 FROM otl.referral_requests
      WHERE team_id=t AND state IN ('pending','approved') AND payload_purge_after<=now_at)
      INTO remaining;
    SELECT min(payload_purge_after) INTO due_at FROM otl.referral_requests
      WHERE team_id=t AND state IN ('pending','approved');
  ELSIF op='audit_retention' THEN
    PERFORM set_config('otl.referral_retention','enabled',true);
    WITH due AS (
      SELECT event_id FROM otl.referral_request_events
      WHERE team_id=t AND audit_purge_after<=now_at
      ORDER BY audit_purge_after,event_id LIMIT batch FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM otl.referral_request_events e USING due
      WHERE e.event_id=due.event_id RETURNING 1
    ) SELECT count(*) INTO processed FROM deleted;
    PERFORM set_config('otl.referral_retention','',true);
    SELECT EXISTS(SELECT 1 FROM otl.referral_request_events
      WHERE team_id=t AND audit_purge_after<=now_at) INTO remaining;
    SELECT min(audit_purge_after) INTO due_at FROM otl.referral_request_events WHERE team_id=t;
  ELSIF op='nonce_retention' THEN
    WITH due AS (
      SELECT ctid FROM otl.community_records
      WHERE team_id=t AND kind='referral_service_nonce'
        AND record_key LIKE 'referral-service-nonce:%'
        AND (body->>'expiresAt')::timestamptz<=now_at
      ORDER BY (body->>'expiresAt')::timestamptz LIMIT batch FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM otl.community_records c USING due WHERE c.ctid=due.ctid RETURNING 1
    ) SELECT count(*) INTO processed FROM deleted;
    SELECT EXISTS(SELECT 1 FROM otl.community_records
      WHERE team_id=t AND kind='referral_service_nonce'
        AND record_key LIKE 'referral-service-nonce:%'
        AND (body->>'expiresAt')::timestamptz<=now_at) INTO remaining;
    SELECT min((body->>'expiresAt')::timestamptz) INTO due_at FROM otl.community_records
      WHERE team_id=t AND kind='referral_service_nonce' AND record_key LIKE 'referral-service-nonce:%';
  ELSE
    RAISE EXCEPTION 'unsupported retention operation';
  END IF;
  RETURN jsonb_build_object('processed',processed,'possiblyMore',remaining,'nextDue',due_at);
END $$;

REVOKE ALL ON FUNCTION otl.referral_retention_execute(text,jsonb) FROM PUBLIC,otl_referral_runtime,otl_referral_admin;
GRANT EXECUTE ON FUNCTION otl.referral_retention_execute(text,jsonb) TO otl_referral_runtime;
INSERT INTO otl.schema_migrations(version) VALUES('034-referral-runtime-retention');
COMMIT;
