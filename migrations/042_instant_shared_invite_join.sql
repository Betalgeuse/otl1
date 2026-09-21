BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:instant-shared-invite-join:042',0));

ALTER TABLE otl.referral_requests
  ADD COLUMN admission_mode text NOT NULL DEFAULT 'manual_review';
ALTER TABLE otl.referral_requests
  ADD CONSTRAINT referral_requests_admission_mode_check
  CHECK(admission_mode IN ('manual_review','shared_invite'));

CREATE OR REPLACE FUNCTION otl.referral_request_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF
    NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
    NEW.receipt_id IS DISTINCT FROM OLD.receipt_id OR NEW.link_id IS DISTINCT FROM OLD.link_id OR
    NEW.referrer_user_id IS DISTINCT FROM OLD.referrer_user_id OR
    NEW.email_digest IS DISTINCT FROM OLD.email_digest OR
    NEW.withdrawal_digest IS DISTINCT FROM OLD.withdrawal_digest OR
    NEW.admission_mode IS DISTINCT FROM OLD.admission_mode OR
    NEW.submission_key IS DISTINCT FROM OLD.submission_key OR
    NEW.submission_hash IS DISTINCT FROM OLD.submission_hash OR
    NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR
    NEW.audit_purge_after IS DISTINCT FROM OLD.audit_purge_after
  THEN RAISE EXCEPTION 'referral identity is immutable'; END IF;
  RETURN NEW;
END $$;

ALTER TABLE otl.referral_request_events DROP CONSTRAINT referral_request_events_event_type_check;
ALTER TABLE otl.referral_request_events ADD CONSTRAINT referral_request_events_event_type_check
  CHECK(event_type IN (
    'submitted','shared_invite_started','withdrawn','approved','declined','duplicate',
    'suspected_abuse','manual_invite_asserted','joined','expired','payload_purge_claimed',
    'payload_purged','payload_purge_failed'
  ));

DROP TRIGGER referral_capacity_guard ON otl.referral_requests;
CREATE OR REPLACE FUNCTION otl.referral_capacity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE availability jsonb;
BEGIN
  IF NEW.state='approved' AND (TG_OP='INSERT' OR OLD.state<>'approved') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(jsonb_build_array(NEW.team_id,NEW.referrer_user_id)::text,36));
    availability:=otl.referral_capacity_status(NEW.team_id,NEW.referrer_user_id);
    IF (availability->>'remaining')::integer<1 THEN
      RAISE EXCEPTION 'referral capacity unavailable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_capacity_guard
  BEFORE INSERT OR UPDATE OF state ON otl.referral_requests
  FOR EACH ROW EXECUTE FUNCTION otl.referral_capacity_guard();

CREATE FUNCTION otl.referral_direct_join(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; digest text:=p->>'tokenDigest'; email_hash text:=p->>'emailDigest';
  key text:=p->>'key'; now_at timestamptz; request_hash text;
  link otl.member_referral_links; request otl.referral_requests;
  submission otl.referral_submission_receipts;
BEGIN
  IF coalesce(t,'')='' OR coalesce(digest,'') !~ '^[0-9a-f]{64}$'
    OR coalesce(email_hash,'') !~ '^[0-9a-f]{64}$'
    OR p->>'consentVersion'<>'invite-consent-v1'
    OR coalesce(p->>'requestId','') !~ '^REQ-[A-Z0-9-]{4,64}$'
    OR coalesce(p->>'receiptId','') !~ '^RCP-[A-Z0-9-]{4,64}$'
    OR coalesce(p->>'withdrawalDigest','') !~ '^[0-9a-f]{64}$'
    OR coalesce(key,'')='' OR coalesce(p->>'now','')=''
    OR coalesce(p->>'consentedAt','')=''
  THEN RAISE EXCEPTION 'invalid direct referral request'; END IF;
  now_at:=(p->>'now')::timestamptz;
  IF (p->>'consentedAt')::timestamptz>now_at THEN
    RAISE EXCEPTION 'invalid referral consent';
  END IF;
  request_hash:=md5((p-'requestId'-'receiptId'-'withdrawalDigest'-'now')::text);

  SELECT * INTO submission FROM otl.referral_submission_receipts
    WHERE team_id=t AND submission_key=key;
  IF FOUND THEN
    IF submission.request_hash<>request_hash THEN
      RAISE EXCEPTION 'referral idempotency collision';
    END IF;
    SELECT * INTO request FROM otl.referral_requests
      WHERE team_id=t AND request_id=submission.request_id;
    RETURN jsonb_build_object('accepted',request.admission_mode='shared_invite',
      'requestId',request.request_id);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,email_hash)::text,30));
  SELECT * INTO request FROM otl.referral_requests
    WHERE team_id=t AND email_digest=email_hash AND state IN ('pending','approved') FOR UPDATE;
  IF FOUND THEN
    IF request.admission_mode<>'shared_invite' OR request.state<>'approved' THEN
      RETURN jsonb_build_object('accepted',false);
    END IF;
    INSERT INTO otl.referral_submission_receipts(
      team_id,submission_key,request_id,request_hash,recorded_at)
    VALUES(t,key,request.request_id,request_hash,now_at);
    RETURN jsonb_build_object('accepted',true,'requestId',request.request_id);
  END IF;

  SELECT * INTO link FROM otl.member_referral_links
    WHERE team_id=t AND token_digest=digest AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accepted',false); END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array(t,link.referrer_user_id)::text,36));
  IF (otl.referral_capacity_status(t,link.referrer_user_id)->>'remaining')::integer<1 THEN
    RETURN jsonb_build_object('accepted',false);
  END IF;

  INSERT INTO otl.referral_requests(
    team_id,request_id,receipt_id,link_id,referrer_user_id,email_digest,withdrawal_digest,
    state,admission_mode,submission_key,submission_hash,submitted_at,payload_purge_after,
    audit_purge_after)
  VALUES(t,p->>'requestId',p->>'receiptId',link.link_id,link.referrer_user_id,email_hash,
    p->>'withdrawalDigest','approved','shared_invite',key,request_hash,now_at,
    now_at+interval '30 days',now_at+interval '12 months')
  RETURNING * INTO request;
  INSERT INTO otl.referral_consents(team_id,request_id,consent_version,consented_at)
    VALUES(t,request.request_id,'invite-consent-v1',(p->>'consentedAt')::timestamptz);
  INSERT INTO otl.referral_submission_receipts(
    team_id,submission_key,request_id,request_hash,recorded_at)
    VALUES(t,key,request.request_id,request_hash,now_at);
  INSERT INTO otl.referral_request_events(
    team_id,request_id,event_key,event_type,actor_class,from_state,to_state,request_hash,
    occurred_at,audit_purge_after,result)
  VALUES(t,request.request_id,key,'shared_invite_started','applicant',NULL,'approved',request_hash,
    now_at,now_at+interval '12 months',otl.referral_receipt(request));
  RETURN jsonb_build_object('accepted',true,'requestId',request.request_id);
END $$;

CREATE FUNCTION otl.referral_attribute_join(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; u text:=p->>'userId'; email_hash text:=p->>'emailDigest';
  event_key text:=p->>'eventId'; now_at timestamptz; request_hash text:=md5(p::text);
  request otl.referral_requests;
BEGIN
  IF coalesce(t,'')='' OR coalesce(u,'') !~ '^[UW][A-Z0-9]+$'
    OR coalesce(email_hash,'') !~ '^[0-9a-f]{64}$' OR coalesce(event_key,'')=''
    OR coalesce(p->>'now','')=''
  THEN RAISE EXCEPTION 'invalid join attribution'; END IF;
  now_at:=(p->>'now')::timestamptz;

  SELECT r.* INTO request FROM otl.member_referral_attributions a
    JOIN otl.referral_requests r USING(team_id,request_id)
    WHERE a.team_id=t AND a.slack_event_id=event_key;
  IF FOUND THEN
    RETURN otl.referral_receipt(request)||jsonb_build_object('newlyAttributed',false);
  END IF;
  SELECT r.* INTO request FROM otl.member_referral_attributions a
    JOIN otl.referral_requests r USING(team_id,request_id)
    WHERE a.team_id=t AND a.introduced_user_id=u;
  IF FOUND THEN
    RETURN otl.referral_receipt(request)||jsonb_build_object('newlyAttributed',false);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.workspace_members m
    WHERE m.team_id=t AND m.user_id=u AND NOT coalesce(m.is_bot,false)
      AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false))
  THEN RETURN NULL; END IF;

  SELECT * INTO request FROM otl.referral_requests r
    WHERE r.team_id=t AND r.email_digest=email_hash AND r.state='approved'
      AND (r.admission_mode='shared_invite' OR EXISTS(
        SELECT 1 FROM otl.referral_manual_invite_assertions a
        WHERE a.team_id=r.team_id AND a.request_id=r.request_id))
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO otl.member_referral_attributions(
    team_id,introduced_user_id,referrer_user_id,request_id,joined_at,slack_event_id)
  VALUES(t,u,request.referrer_user_id,request.request_id,now_at,event_key);
  UPDATE otl.referral_requests SET state='joined',revision=revision+1,terminal_at=now_at,
    payload_purge_after=now_at+interval '7 days'
    WHERE team_id=t AND request_id=request.request_id RETURNING * INTO request;
  INSERT INTO otl.referral_request_events(
    team_id,request_id,event_key,event_type,actor_class,actor_id,from_state,to_state,
    request_hash,occurred_at,audit_purge_after,result)
  VALUES(t,request.request_id,'join:'||event_key,'joined','runtime',u,'approved','joined',
    request_hash,now_at,now_at+interval '12 months',otl.referral_receipt(request));
  INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
    VALUES(t,request.request_id,'join:'||event_key,'join_observed',now_at)
    ON CONFLICT DO NOTHING;
  RETURN otl.referral_receipt(request)||jsonb_build_object('newlyAttributed',true);
END $$;

REVOKE ALL ON FUNCTION otl.referral_direct_join(jsonb),otl.referral_attribute_join(jsonb)
  FROM PUBLIC,otl_referral_admin,otl_referral_admin_login;
GRANT EXECUTE ON FUNCTION otl.referral_direct_join(jsonb),otl.referral_attribute_join(jsonb)
  TO otl_referral_runtime;

INSERT INTO otl.schema_migrations(version) VALUES('042-instant-shared-invite-join');
COMMIT;
