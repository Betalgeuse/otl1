BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:interest-requests:037',0));

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_interest_member') THEN
    CREATE ROLE otl_interest_member NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_interest_member_login') THEN
    CREATE ROLE otl_interest_member_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('otl_interest_member','otl_interest_member_login') AND rolsuper)
  THEN RAISE EXCEPTION 'unsafe interest member role'; END IF;
END $$;
GRANT USAGE ON SCHEMA otl TO otl_interest_member;
GRANT otl_interest_member TO otl_interest_member_login;

CREATE TABLE otl.interest_requests (
  team_id text NOT NULL REFERENCES otl.workspaces(team_id),
  interest_id text NOT NULL CHECK(interest_id~'^IREQ-[A-Z0-9-]{4,64}$'),
  receipt_id text NOT NULL CHECK(receipt_id~'^INT-[A-Z0-9-]{4,64}$'),
  email_digest text NOT NULL CHECK(email_digest~'^[0-9a-f]{64}$'),
  withdrawal_digest text NOT NULL CHECK(withdrawal_digest~'^[0-9a-f]{64}$'),
  submission_key text NOT NULL CHECK(btrim(submission_key)<>''),
  submission_hash text NOT NULL CHECK(submission_hash~'^[0-9a-f]{32}$'),
  state text NOT NULL DEFAULT 'pending_introduction' CHECK(state IN
    ('pending_introduction','introduction_verified','attached','withdrawn','declined','expired')),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  submitted_at timestamptz NOT NULL,
  terminal_at timestamptz,
  payload_purge_after timestamptz NOT NULL,
  audit_purge_after timestamptz NOT NULL,
  PRIMARY KEY(team_id,interest_id),
  UNIQUE(team_id,receipt_id),
  UNIQUE(team_id,submission_key),
  CHECK((state IN ('withdrawn','declined','expired'))=(terminal_at IS NOT NULL)),
  CHECK(payload_purge_after>=submitted_at),
  CHECK(audit_purge_after>=payload_purge_after)
);
CREATE UNIQUE INDEX interest_requests_one_open_email ON otl.interest_requests(team_id,email_digest)
  WHERE state IN ('pending_introduction','introduction_verified');
CREATE TABLE otl.interest_consents (
  team_id text NOT NULL,
  interest_id text NOT NULL,
  consent_version text NOT NULL CHECK(consent_version='interest-consent-v1'),
  consented_at timestamptz NOT NULL,
  share_name_email_with_introducer boolean NOT NULL,
  PRIMARY KEY(team_id,interest_id),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id)
);
CREATE TABLE otl.interest_attachment_consents (
  team_id text NOT NULL,
  interest_id text NOT NULL,
  consent_version text NOT NULL CHECK(consent_version='invite-consent-v1'),
  consented_at timestamptz NOT NULL,
  event_key text NOT NULL,
  PRIMARY KEY(team_id,interest_id),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id)
);
CREATE TABLE otl.interest_private_payloads (
  team_id text NOT NULL,
  interest_id text NOT NULL,
  opaque_ref text NOT NULL CHECK(opaque_ref~'^interest-private/IREQ-[A-Z0-9-]{4,64}/revision-0-[0-9a-f-]+\.enc$'),
  object_digest text NOT NULL CHECK(object_digest~'^[0-9a-f]{64}$'),
  envelope_dek text,
  nonce text,
  key_version text NOT NULL CHECK(key_version~'^[a-z0-9][a-z0-9._-]{0,63}$'),
  schema_version text NOT NULL CHECK(schema_version='interest-application.v1'),
  purge_status text NOT NULL DEFAULT 'pending' CHECK(purge_status IN ('pending','claimed','failed','purged','dead')),
  purge_attempts integer NOT NULL DEFAULT 0 CHECK(purge_attempts>=0),
  purge_claim_key text,
  purge_retry_at timestamptz,
  purged_at timestamptz,
  PRIMARY KEY(team_id,interest_id),
  UNIQUE(opaque_ref),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id),
  CHECK((purge_status='purged')=(purged_at IS NOT NULL)),
  CHECK(purge_status='purged' OR (envelope_dek IS NOT NULL AND nonce IS NOT NULL))
);
CREATE TABLE otl.interest_submission_receipts (
  team_id text NOT NULL,
  submission_key text NOT NULL CHECK(btrim(submission_key)<>''),
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{32}$'),
  interest_id text,
  receipt_id text NOT NULL CHECK(receipt_id~'^INT-[A-Z0-9-]{4,64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(team_id,submission_key),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id)
);
CREATE TABLE otl.interest_introduction_evidence (
  team_id text NOT NULL,
  interest_id text NOT NULL,
  member_id text NOT NULL,
  evidence_type text NOT NULL CHECK(evidence_type IN
    ('slack_signed_confirmation','offline_email','offline_call','offline_document')),
  evidence_digest text NOT NULL CHECK(evidence_digest~'^[0-9a-f]{64}$'),
  actor_id text NOT NULL,
  evidence_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  event_key text NOT NULL,
  PRIMARY KEY(team_id,interest_id),
  UNIQUE(team_id,event_key),
  UNIQUE(team_id,evidence_digest),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id),
  FOREIGN KEY(team_id,member_id) REFERENCES otl.workspace_members(team_id,user_id)
);
CREATE TABLE otl.interest_referral_bridges (
  team_id text NOT NULL,
  interest_id text NOT NULL,
  request_id text NOT NULL,
  member_id text NOT NULL,
  attached_by text NOT NULL,
  attached_at timestamptz NOT NULL,
  event_key text NOT NULL,
  PRIMARY KEY(team_id,interest_id),
  UNIQUE(team_id,request_id),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id)
);
CREATE TABLE otl.interest_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  interest_id text NOT NULL,
  event_key text NOT NULL CHECK(btrim(event_key)<>''),
  event_type text NOT NULL CHECK(event_type IN ('submitted','introduction_requested','introduction_verified',
    'attached','withdrawn','declined','expired','payload_purge_claimed','payload_purged','payload_purge_failed','payload_purge_dead')),
  actor_class text NOT NULL CHECK(actor_class IN ('applicant','admin','member','retention')),
  actor_id text,
  from_state text,
  to_state text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{32}$'),
  occurred_at timestamptz NOT NULL,
  audit_purge_after timestamptz NOT NULL,
  result jsonb NOT NULL,
  UNIQUE(team_id,interest_id,event_key),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id)
);
CREATE TABLE otl.interest_outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  interest_id text NOT NULL,
  effect_key text NOT NULL,
  effect_type text NOT NULL CHECK(effect_type IN ('admin_review','introduction_requested','introduction_verified','attached','withdrawn','declined')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','sent','failed','cancelled','dead')),
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  claim_key text,
  UNIQUE(team_id,effect_key),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id)
);
CREATE TABLE otl.interest_service_nonces (
  team_id text NOT NULL,
  nonce_digest text NOT NULL CHECK(nonce_digest~'^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(team_id,nonce_digest)
);
CREATE TABLE otl.interest_introduction_prompts (
  team_id text NOT NULL,
  interest_id text NOT NULL,
  member_id text NOT NULL,
  expected_revision integer NOT NULL CHECK(expected_revision>=0),
  nonce_digest text NOT NULL CHECK(nonce_digest~'^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(team_id,interest_id),
  UNIQUE(team_id,nonce_digest),
  FOREIGN KEY(team_id,interest_id) REFERENCES otl.interest_requests(team_id,interest_id),
  FOREIGN KEY(team_id,member_id) REFERENCES otl.workspace_members(team_id,user_id),
  CHECK(expires_at>requested_at)
);
CREATE FUNCTION otl.interest_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF (NEW.team_id,NEW.interest_id,NEW.receipt_id,NEW.email_digest,NEW.withdrawal_digest,
      NEW.submission_key,NEW.submission_hash,NEW.submitted_at,NEW.audit_purge_after)
     IS DISTINCT FROM
     (OLD.team_id,OLD.interest_id,OLD.receipt_id,OLD.email_digest,OLD.withdrawal_digest,
      OLD.submission_key,OLD.submission_hash,OLD.submitted_at,OLD.audit_purge_after)
  THEN RAISE EXCEPTION 'interest identity immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interest_identity_guard BEFORE UPDATE ON otl.interest_requests
  FOR EACH ROW EXECUTE FUNCTION otl.interest_identity_guard();
CREATE FUNCTION otl.interest_payload_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF (NEW.team_id,NEW.interest_id,NEW.opaque_ref,NEW.object_digest,NEW.key_version,NEW.schema_version)
    IS DISTINCT FROM (OLD.team_id,OLD.interest_id,OLD.opaque_ref,OLD.object_digest,OLD.key_version,OLD.schema_version)
  THEN RAISE EXCEPTION 'interest payload identity immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interest_payload_identity_guard BEFORE UPDATE ON otl.interest_private_payloads
  FOR EACH ROW EXECUTE FUNCTION otl.interest_payload_identity_guard();
CREATE FUNCTION otl.interest_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('otl.interest_retention',true)='enabled' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'interest audit immutable';
END $$;
CREATE TRIGGER interest_consents_immutable BEFORE UPDATE OR DELETE ON otl.interest_consents
  FOR EACH ROW EXECUTE FUNCTION otl.interest_audit_guard();
CREATE TRIGGER interest_attachment_consents_immutable BEFORE UPDATE OR DELETE ON otl.interest_attachment_consents
  FOR EACH ROW EXECUTE FUNCTION otl.interest_audit_guard();
CREATE TRIGGER interest_evidence_immutable BEFORE UPDATE OR DELETE ON otl.interest_introduction_evidence
  FOR EACH ROW EXECUTE FUNCTION otl.interest_audit_guard();
CREATE TRIGGER interest_bridges_immutable BEFORE UPDATE OR DELETE ON otl.interest_referral_bridges
  FOR EACH ROW EXECUTE FUNCTION otl.interest_audit_guard();
CREATE TRIGGER interest_events_immutable BEFORE UPDATE OR DELETE ON otl.interest_events
  FOR EACH ROW EXECUTE FUNCTION otl.interest_audit_guard();
CREATE TRIGGER interest_receipts_immutable BEFORE UPDATE OR DELETE ON otl.interest_submission_receipts
  FOR EACH ROW EXECUTE FUNCTION otl.interest_audit_guard();

-- The 030 submit operation already uses this advisory lock. This trigger makes its later
-- insert observe open interests under that same lock, including direct SQL callers.
CREATE FUNCTION otl.interest_referral_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(NEW.team_id,NEW.email_digest)::text,30));
  IF EXISTS(SELECT 1 FROM otl.interest_requests i WHERE i.team_id=NEW.team_id
      AND i.email_digest=NEW.email_digest AND i.state IN ('pending_introduction','introduction_verified'))
  THEN RAISE EXCEPTION 'open interest exists'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interest_referral_guard BEFORE INSERT ON otl.referral_requests
  FOR EACH ROW EXECUTE FUNCTION otl.interest_referral_guard();

CREATE FUNCTION otl.interest_member_active(t text,u text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
 SELECT EXISTS(SELECT 1 FROM otl.member_lifecycles l
   JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
   JOIN otl.workspace_members m USING(team_id,user_id)
   WHERE l.team_id=t AND l.user_id=u AND l.state='active' AND cm.is_current
     AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false)
     AND NOT coalesce(m.slack_deleted,false))
$$;
CREATE FUNCTION otl.interest_receipt(i otl.interest_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
  SELECT jsonb_build_object('receiptId',i.receipt_id,'accepted',true)
$$;

CREATE FUNCTION otl.interest_runtime_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; k text:=p->>'key'; h text:=md5(p::text);
  now_at timestamptz; i otl.interest_requests; s otl.interest_submission_receipts;
  e otl.interest_events; b otl.interest_referral_bridges; r otl.referral_requests;
  old_state text; result jsonb;
BEGIN
  IF coalesce(t,'')='' THEN RAISE EXCEPTION 'invalid interest scope'; END IF;
  IF op='claim_nonce' THEN
    IF coalesce(p->>'nonceDigest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p->>'expiresAt','')=''
      OR (p->>'expiresAt')::timestamptz<=transaction_timestamp()
      OR (p->>'expiresAt')::timestamptz>transaction_timestamp()+interval '6 minutes'
    THEN RAISE EXCEPTION 'invalid interest service nonce'; END IF;
    INSERT INTO otl.interest_service_nonces(team_id,nonce_digest,expires_at)
      VALUES(t,p->>'nonceDigest',(p->>'expiresAt')::timestamptz)
      ON CONFLICT DO NOTHING;
    RETURN to_jsonb(FOUND);
  END IF;
  IF op='find_submission' THEN
    IF coalesce(k,'') !~ '^[A-Za-z0-9_-]{8,120}$'
    THEN RAISE EXCEPTION 'invalid interest submission key'; END IF;
    SELECT * INTO s FROM otl.interest_submission_receipts
      WHERE team_id=t AND submission_key=k;
    IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
    RETURN jsonb_build_object('receiptId',s.receipt_id,'accepted',true,'created',false,
      'sameSubmissionKey',s.interest_id IS NOT NULL);
  ELSIF op='find_private_intake' THEN
    IF coalesce(p->>'interestId','') !~ '^IREQ-[A-Z0-9-]{4,64}$'
      OR coalesce(p->>'objectDigest','') !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid interest private lookup'; END IF;
    IF EXISTS(SELECT 1 FROM otl.interest_private_payloads pp WHERE pp.team_id=t
      AND pp.interest_id=p->>'interestId' AND pp.object_digest=p->>'objectDigest')
    THEN RETURN to_jsonb('adopted'::text); END IF;
    IF EXISTS(SELECT 1 FROM otl.interest_private_payloads pp WHERE pp.team_id=t
      AND (pp.interest_id=p->>'interestId' OR pp.object_digest=p->>'objectDigest'))
    THEN RETURN to_jsonb('conflict'::text); END IF;
    RETURN to_jsonb('absent'::text);
  END IF;
  IF coalesce(k,'') !~ '^[A-Za-z0-9_-]{8,120}$' OR coalesce(p->>'now','')=''
  THEN RAISE EXCEPTION 'invalid interest scope'; END IF;
  now_at:=(p->>'now')::timestamptz;
  IF op='submit' THEN
    IF coalesce(p->>'interestId','') !~ '^IREQ-[A-Z0-9-]{4,64}$'
      OR coalesce(p->>'receiptId','') !~ '^INT-[A-Z0-9-]{4,64}$'
      OR coalesce(p->>'emailDigest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p->>'contentDigest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p->>'withdrawalDigest','') !~ '^[0-9a-f]{64}$'
      OR p->>'consentVersion'<>'interest-consent-v1'
      OR coalesce(jsonb_typeof(p->'shareNameEmailWithIntroducer'),'')<>'boolean'
      OR coalesce(jsonb_typeof(p->'inviteConsentAccepted'),'')<>'boolean'
      OR coalesce(p->>'inviteConsentAccepted','')<>'true'
      OR coalesce(p->>'inviteConsentedAt','')=''
      OR coalesce(p->>'objectDigest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p->>'opaqueRef','') !~ '^interest-private/IREQ-[A-Z0-9-]{4,64}/revision-0-[0-9a-f-]+\.enc$'
      OR p->>'opaqueRef' NOT LIKE 'interest-private/'||(p->>'interestId')||'/revision-0-%'
      OR p->>'schemaVersion'<>'interest-application.v1'
      OR coalesce(p->>'keyVersion','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      OR coalesce(p->>'envelopeDek','')='' OR coalesce(p->>'nonce','')=''
    THEN RAISE EXCEPTION 'invalid interest submission'; END IF;
    IF (p->>'consentedAt')::timestamptz>now_at
      OR (p->>'inviteConsentedAt')::timestamptz>now_at
    THEN RAISE EXCEPTION 'invalid interest consent'; END IF;
    h:=md5(jsonb_build_object('teamId',t,'emailDigest',p->>'emailDigest',
      'contentDigest',p->>'contentDigest','consentVersion',p->>'consentVersion',
      'shareNameEmailWithIntroducer',p->'shareNameEmailWithIntroducer',
      'inviteConsentAccepted',p->'inviteConsentAccepted')::text);
    SELECT * INTO s FROM otl.interest_submission_receipts WHERE team_id=t AND submission_key=k;
    IF FOUND THEN
      IF s.request_hash<>h THEN RAISE EXCEPTION 'interest idempotency collision'; END IF;
      RETURN jsonb_build_object('receiptId',s.receipt_id,'accepted',true,'created',false,
        'sameSubmissionKey',s.interest_id IS NOT NULL);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,p->>'emailDigest')::text,30));
    IF EXISTS(SELECT 1 FROM otl.referral_requests WHERE team_id=t AND email_digest=p->>'emailDigest'
        AND state IN ('pending','approved')) OR
       EXISTS(SELECT 1 FROM otl.interest_requests WHERE team_id=t AND email_digest=p->>'emailDigest'
        AND state IN ('pending_introduction','introduction_verified')) THEN
      INSERT INTO otl.interest_submission_receipts(team_id,submission_key,request_hash,receipt_id,recorded_at)
        VALUES(t,k,h,p->>'receiptId',now_at);
      RETURN jsonb_build_object('receiptId',p->>'receiptId','accepted',true,'created',false,
        'sameSubmissionKey',false);
    END IF;
    INSERT INTO otl.interest_requests(team_id,interest_id,receipt_id,email_digest,withdrawal_digest,
      submission_key,submission_hash,submitted_at,payload_purge_after,audit_purge_after)
    VALUES(t,p->>'interestId',p->>'receiptId',p->>'emailDigest',p->>'withdrawalDigest',k,h,now_at,
      now_at+interval '30 days',now_at+interval '12 months') RETURNING * INTO i;
    INSERT INTO otl.interest_consents(team_id,interest_id,consent_version,consented_at,share_name_email_with_introducer)
      VALUES(t,i.interest_id,'interest-consent-v1',(p->>'consentedAt')::timestamptz,
        (p->>'shareNameEmailWithIntroducer')::boolean);
    INSERT INTO otl.interest_attachment_consents(team_id,interest_id,consent_version,consented_at,event_key)
      VALUES(t,i.interest_id,'invite-consent-v1',(p->>'inviteConsentedAt')::timestamptz,k);
    INSERT INTO otl.interest_private_payloads(team_id,interest_id,opaque_ref,object_digest,envelope_dek,nonce,key_version,schema_version)
      VALUES(t,i.interest_id,p->>'opaqueRef',p->>'objectDigest',p->>'envelopeDek',p->>'nonce',p->>'keyVersion','interest-application.v1');
    INSERT INTO otl.interest_submission_receipts(team_id,submission_key,request_hash,interest_id,receipt_id,recorded_at)
      VALUES(t,k,h,i.interest_id,i.receipt_id,now_at);
    result:=otl.interest_receipt(i);
    INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,to_state,request_hash,occurred_at,audit_purge_after,result)
      VALUES(t,i.interest_id,k,'submitted','applicant',i.state,h,now_at,i.audit_purge_after,result);
    INSERT INTO otl.interest_outbox(team_id,interest_id,effect_key,effect_type,available_at)
      VALUES(t,i.interest_id,'review:'||i.interest_id,'admin_review',now_at);
    RETURN result||jsonb_build_object('created',true,'sameSubmissionKey',true);
  ELSIF op='withdraw' THEN
    IF coalesce(p->>'receiptId','') !~ '^INT-[A-Z0-9-]{4,64}$'
      OR coalesce(p->>'withdrawalDigest','') !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid interest withdrawal'; END IF;
    SELECT * INTO i FROM otl.interest_requests WHERE team_id=t AND receipt_id=p->>'receiptId'
      AND withdrawal_digest=p->>'withdrawalDigest' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'interest unavailable'; END IF;
    SELECT * INTO e FROM otl.interest_events WHERE team_id=t AND interest_id=i.interest_id AND event_key=k;
    IF FOUND THEN
      IF e.request_hash<>h THEN RAISE EXCEPTION 'interest idempotency collision'; END IF;
      RETURN e.result;
    END IF;
    IF i.state NOT IN ('pending_introduction','introduction_verified','attached')
    THEN RAISE EXCEPTION 'interest terminal'; END IF;
    IF i.state='attached' THEN
      SELECT * INTO b FROM otl.interest_referral_bridges WHERE team_id=t AND interest_id=i.interest_id;
      SELECT * INTO r FROM otl.referral_requests WHERE team_id=t AND request_id=b.request_id FOR UPDATE;
      IF r.state NOT IN ('pending','approved') THEN RAISE EXCEPTION 'downstream referral terminal'; END IF;
      PERFORM otl.referral_runtime_execute('withdraw',jsonb_build_object('teamId',t,'receiptId',r.receipt_id,
        'withdrawalDigest',r.withdrawal_digest,'key','interest-withdraw:'||k,'now',now_at));
    END IF;
    old_state:=i.state;
    UPDATE otl.interest_requests SET state='withdrawn',revision=revision+1,terminal_at=now_at,
      payload_purge_after=now_at+interval '24 hours' WHERE team_id=t AND interest_id=i.interest_id RETURNING * INTO i;
    result:=otl.interest_receipt(i);
    INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,from_state,to_state,
      request_hash,occurred_at,audit_purge_after,result)
      VALUES(t,i.interest_id,k,'withdrawn','applicant',old_state,'withdrawn',h,now_at,i.audit_purge_after,result);
    UPDATE otl.interest_outbox SET status='cancelled' WHERE team_id=t AND interest_id=i.interest_id
      AND status IN ('pending','failed');
    INSERT INTO otl.interest_outbox(team_id,interest_id,effect_key,effect_type,available_at)
      VALUES(t,i.interest_id,'withdrawn:'||i.interest_id,'withdrawn',now_at);
    RETURN result;
  END IF;
  RAISE EXCEPTION 'unsupported interest runtime operation';
END $$;

CREATE FUNCTION otl.interest_admin_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; a text:=p->>'adminId'; k text:=p->>'key';
  h text:=md5(p::text); now_at timestamptz; i otl.interest_requests;
  e otl.interest_events; b otl.interest_referral_bridges;
  evidence otl.interest_introduction_evidence; invite_consent otl.interest_attachment_consents;
  link otl.member_referral_links;
  referral jsonb; result jsonb; old_state text;
BEGIN
  IF coalesce(t,'')='' OR coalesce(a,'')='' OR coalesce(k,'') !~ '^[A-Za-z0-9_-]{8,120}$' OR coalesce(p->>'now','')=''
     OR NOT EXISTS(SELECT 1 FROM otl.referral_admins WHERE team_id=t AND user_id=a)
  THEN RAISE EXCEPTION 'interest admin denied'; END IF;
  now_at:=(p->>'now')::timestamptz;
  SELECT * INTO i FROM otl.interest_requests WHERE team_id=t AND interest_id=p->>'interestId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'interest unavailable'; END IF;
  IF op='context' THEN
    SELECT ev.* INTO evidence FROM otl.interest_introduction_evidence ev
      WHERE ev.team_id=t AND ev.interest_id=i.interest_id;
    SELECT l.* INTO link FROM otl.member_referral_links l
      WHERE l.team_id=t AND l.referrer_user_id=evidence.member_id AND l.status='active';
    RETURN jsonb_build_object('interestId',i.interest_id,'state',i.state,'revision',i.revision,
      'emailDigest',i.email_digest,'memberId',evidence.member_id,
      'tokenDigest',CASE WHEN otl.interest_member_active(t,evidence.member_id) THEN link.token_digest ELSE NULL END,
      'shareNameEmailWithIntroducer',(SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id),
      'opaqueRef',(SELECT opaque_ref FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id),
      'objectDigest',(SELECT object_digest FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id),
      'envelopeDek',(SELECT envelope_dek FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id),
      'nonce',(SELECT nonce FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id),
      'keyVersion',(SELECT key_version FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id),
      'schemaVersion','interest-application.v1');
  END IF;
  SELECT * INTO e FROM otl.interest_events WHERE team_id=t AND interest_id=i.interest_id AND event_key=k;
  IF FOUND THEN
    IF e.request_hash<>h THEN RAISE EXCEPTION 'interest idempotency collision'; END IF;
    RETURN e.result;
  END IF;
  IF coalesce(p->>'expectedRevision','') !~ '^[0-9]+$' OR i.revision<>(p->>'expectedRevision')::integer
  THEN RAISE EXCEPTION 'stale interest revision'; END IF;
  IF op='request_introduction' THEN
    IF i.state<>'pending_introduction'
      OR NOT EXISTS(SELECT 1 FROM otl.interest_consents c WHERE c.team_id=t
        AND c.interest_id=i.interest_id AND c.share_name_email_with_introducer)
      OR NOT otl.interest_member_active(t,p->>'memberId')
      OR coalesce(p->>'nonceDigest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p->>'expiresAt','')=''
      OR (p->>'expiresAt')::timestamptz<=now_at
      OR (p->>'expiresAt')::timestamptz>now_at+interval '7 days'
    THEN RAISE EXCEPTION 'introduction prompt unavailable'; END IF;
    INSERT INTO otl.interest_introduction_prompts(team_id,interest_id,member_id,
      expected_revision,nonce_digest,requested_at,expires_at)
      VALUES(t,i.interest_id,p->>'memberId',i.revision,p->>'nonceDigest',now_at,
        (p->>'expiresAt')::timestamptz)
      ON CONFLICT(team_id,interest_id) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'introduction prompt already issued'; END IF;
    result:=jsonb_build_object('interestId',i.interest_id,'state',i.state,'revision',i.revision);
    INSERT INTO otl.interest_outbox(team_id,interest_id,effect_key,effect_type,available_at)
      VALUES(t,i.interest_id,'intro-request:'||k,'introduction_requested',now_at);
  ELSIF op='verify_offline' THEN
    RAISE EXCEPTION 'offline introduction unavailable';
  ELSIF op='attach' THEN
    IF i.state<>'introduction_verified' THEN RAISE EXCEPTION 'introduction unverified'; END IF;
    SELECT * INTO evidence FROM otl.interest_introduction_evidence
      WHERE team_id=t AND interest_id=i.interest_id;
    IF NOT FOUND OR NOT otl.interest_member_active(t,evidence.member_id)
    THEN RAISE EXCEPTION 'introducer unavailable'; END IF;
    SELECT * INTO link FROM otl.member_referral_links WHERE team_id=t
      AND referrer_user_id=evidence.member_id AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'introducer link unavailable'; END IF;
    SELECT * INTO invite_consent FROM otl.interest_attachment_consents ac WHERE ac.team_id=t
      AND ac.interest_id=i.interest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'attachment consent unavailable'; END IF;
    IF NOT EXISTS(SELECT 1 FROM otl.interest_consents c WHERE c.team_id=t
      AND c.interest_id=i.interest_id AND c.share_name_email_with_introducer)
    THEN RAISE EXCEPTION 'sharing consent unavailable'; END IF;
    referral:=p->'referral';
    IF jsonb_typeof(referral)<>'object' OR referral->>'teamId'<>t
      OR referral->>'tokenDigest'<>link.token_digest
      OR referral->>'emailDigest'<>i.email_digest
      OR referral->>'consentVersion'<>'invite-consent-v1'
      OR invite_consent.consented_at>now_at
      OR coalesce(referral->>'requestId','') !~ '^REQ-[A-Z0-9-]{4,64}$'
      OR coalesce(referral->>'opaqueRef','') !~ '^invite-private/REQ-[A-Z0-9-]{4,64}/'
      OR referral->>'key'<>'interest-attach:'||i.interest_id
    THEN RAISE EXCEPTION 'invalid referral attachment'; END IF;
    referral:=jsonb_set(referral,'{consentedAt}',to_jsonb(invite_consent.consented_at::text));
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,i.email_digest)::text,30));
    IF EXISTS(SELECT 1 FROM otl.referral_requests WHERE team_id=t AND email_digest=i.email_digest
      AND state IN ('pending','approved')) THEN RAISE EXCEPTION 'open referral exists'; END IF;
    UPDATE otl.interest_requests SET state='attached',revision=revision+1,
      payload_purge_after=now_at+interval '24 hours'
      WHERE team_id=t AND interest_id=i.interest_id RETURNING * INTO i;
    -- 030 validates the ordinary referral and writes its consent, audit and outbox. The
    -- uncapped implementation is intentionally private; 036 still guards later approval.
    PERFORM otl.referral_runtime_uncapped('submit',referral);
    IF NOT EXISTS(SELECT 1 FROM otl.referral_requests r WHERE r.team_id=t
      AND r.request_id=referral->>'requestId' AND r.referrer_user_id=evidence.member_id
      AND r.email_digest=i.email_digest AND r.state='pending')
    THEN RAISE EXCEPTION 'referral attachment unavailable'; END IF;
    INSERT INTO otl.interest_referral_bridges(team_id,interest_id,request_id,member_id,attached_by,attached_at,event_key)
      VALUES(t,i.interest_id,referral->>'requestId',evidence.member_id,a,now_at,k) RETURNING * INTO b;
    result:=jsonb_build_object('interestId',i.interest_id,'requestId',b.request_id,
      'state',i.state,'revision',i.revision);
    INSERT INTO otl.interest_outbox(team_id,interest_id,effect_key,effect_type,available_at)
      VALUES(t,i.interest_id,'attached:'||k,'attached',now_at);
  ELSIF op='decline' THEN
    IF i.state NOT IN ('pending_introduction','introduction_verified')
    THEN RAISE EXCEPTION 'interest unavailable'; END IF;
    old_state:=i.state;
    UPDATE otl.interest_requests SET state='declined',revision=revision+1,terminal_at=now_at,
      payload_purge_after=now_at+interval '24 hours'
      WHERE team_id=t AND interest_id=i.interest_id RETURNING * INTO i;
    result:=jsonb_build_object('interestId',i.interest_id,'state',i.state,'revision',i.revision);
    UPDATE otl.interest_outbox SET status='cancelled' WHERE team_id=t AND interest_id=i.interest_id
      AND status IN ('pending','failed');
    INSERT INTO otl.interest_outbox(team_id,interest_id,effect_key,effect_type,available_at)
      VALUES(t,i.interest_id,'declined:'||k,'declined',now_at);
  ELSE
    RAISE EXCEPTION 'unsupported interest admin operation';
  END IF;
  INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,actor_id,
    from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,i.interest_id,k,CASE op WHEN 'request_introduction' THEN 'introduction_requested'
      WHEN 'verify_offline' THEN 'introduction_verified' WHEN 'attach' THEN 'attached' WHEN 'decline' THEN 'declined' ELSE op END,'admin',a,
      coalesce(old_state,CASE WHEN op='attach' THEN 'introduction_verified' ELSE i.state END),
      i.state,h,now_at,i.audit_purge_after,result);
  RETURN result;
END $$;

-- This entry point is for a Slack-signature-verifying worker using otl_interest_member.
-- A site-HMAC/runtime credential has no EXECUTE grant. The nonce digest binds the
-- upstream signed interaction to a one-time exact interest/revision/member request.
CREATE FUNCTION otl.interest_member_confirm(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; u text:=p->>'memberId'; k text:=p->>'key';
  h text:=md5(p::text); now_at timestamptz; i otl.interest_requests; e otl.interest_events;
  result jsonb; prompt otl.interest_introduction_prompts;
BEGIN
  IF p->>'operation'='context' THEN
    IF coalesce(t,'')='' OR coalesce(u,'')='' OR coalesce(p->>'interestId','')=''
      OR coalesce(p->>'signedNonceDigest','') !~ '^[0-9a-f]{64}$'
      OR NOT otl.interest_member_active(t,u)
    THEN RAISE EXCEPTION 'member introduction denied'; END IF;
    SELECT * INTO prompt FROM otl.interest_introduction_prompts
      WHERE team_id=t AND interest_id=p->>'interestId' AND member_id=u
        AND nonce_digest=p->>'signedNonceDigest' AND consumed_at IS NULL
        AND expires_at>transaction_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'introduction prompt unavailable'; END IF;
    SELECT * INTO i FROM otl.interest_requests WHERE team_id=t AND interest_id=prompt.interest_id;
    IF NOT FOUND OR i.state<>'pending_introduction' OR i.revision<>prompt.expected_revision
    THEN RAISE EXCEPTION 'stale introduction'; END IF;
    RETURN jsonb_build_object('interestId',i.interest_id,'revision',i.revision,
      'shareNameEmailWithIntroducer',(SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id),
      'opaqueRef',CASE WHEN (SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id) THEN
        (SELECT opaque_ref FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id) ELSE NULL END,
      'objectDigest',CASE WHEN (SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id) THEN
        (SELECT object_digest FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id) ELSE NULL END,
      'envelopeDek',CASE WHEN (SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id) THEN
        (SELECT envelope_dek FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id) ELSE NULL END,
      'nonce',CASE WHEN (SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id) THEN
        (SELECT nonce FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id) ELSE NULL END,
      'keyVersion',CASE WHEN (SELECT share_name_email_with_introducer FROM otl.interest_consents c
        WHERE c.team_id=t AND c.interest_id=i.interest_id) THEN
        (SELECT key_version FROM otl.interest_private_payloads pp WHERE pp.team_id=t AND pp.interest_id=i.interest_id) ELSE NULL END,
      'schemaVersion','interest-application.v1');
  END IF;
  IF coalesce(t,'')='' OR coalesce(u,'')='' OR coalesce(k,'')=''
    OR coalesce(p->>'now','')='' OR coalesce(p->>'signedNonceDigest','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p->>'evidenceDigest','') !~ '^[0-9a-f]{64}$'
    OR p->>'evidenceDigest'<>p->>'signedNonceDigest'
    OR NOT otl.interest_member_active(t,u)
  THEN RAISE EXCEPTION 'member introduction denied'; END IF;
  now_at:=(p->>'now')::timestamptz;
  SELECT * INTO i FROM otl.interest_requests WHERE team_id=t AND interest_id=p->>'interestId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'interest unavailable'; END IF;
  SELECT * INTO e FROM otl.interest_events WHERE team_id=t AND interest_id=i.interest_id AND event_key=k;
  IF FOUND THEN
    IF e.request_hash<>h THEN RAISE EXCEPTION 'interest idempotency collision'; END IF;
    RETURN e.result;
  END IF;
  IF i.state<>'pending_introduction'
    OR NOT EXISTS(SELECT 1 FROM otl.interest_consents c WHERE c.team_id=t
      AND c.interest_id=i.interest_id AND c.share_name_email_with_introducer)
    OR coalesce(p->>'expectedRevision','') !~ '^[0-9]+$'
    OR i.revision<>(p->>'expectedRevision')::integer
  THEN RAISE EXCEPTION 'stale introduction'; END IF;
  SELECT * INTO prompt FROM otl.interest_introduction_prompts WHERE team_id=t
    AND interest_id=i.interest_id AND member_id=u AND nonce_digest=p->>'signedNonceDigest'
    AND expected_revision=i.revision AND consumed_at IS NULL AND expires_at>now_at FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'introduction prompt unavailable'; END IF;
  UPDATE otl.interest_introduction_prompts SET consumed_at=now_at
    WHERE team_id=t AND interest_id=i.interest_id;
  INSERT INTO otl.interest_introduction_evidence(team_id,interest_id,member_id,evidence_type,
    evidence_digest,actor_id,evidence_at,verified_at,event_key)
    VALUES(t,i.interest_id,u,'slack_signed_confirmation',p->>'evidenceDigest',u,now_at,now_at,k);
  UPDATE otl.interest_requests SET state='introduction_verified',revision=revision+1
    WHERE team_id=t AND interest_id=i.interest_id RETURNING * INTO i;
  result:=jsonb_build_object('interestId',i.interest_id,'state',i.state,'revision',i.revision);
  INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,actor_id,
    from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,i.interest_id,k,'introduction_verified','member',u,'pending_introduction',i.state,
      h,now_at,i.audit_purge_after,result);
  INSERT INTO otl.interest_outbox(team_id,interest_id,effect_key,effect_type,available_at)
    VALUES(t,i.interest_id,'intro-verified:'||k,'introduction_verified',now_at);
  RETURN result;
END $$;

CREATE FUNCTION otl.interest_delivery_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; a text:=p->>'adminId'; now_at timestamptz; o otl.interest_outbox; k text:=p->>'claimKey';
BEGIN
  IF coalesce(t,'')='' OR coalesce(p->>'now','')='' OR coalesce(k,'')=''
    OR NOT EXISTS(SELECT 1 FROM otl.referral_admins WHERE team_id=t AND user_id=a)
  THEN RAISE EXCEPTION 'invalid interest delivery'; END IF;
  now_at:=(p->>'now')::timestamptz;
  IF op='claim' THEN
    SELECT * INTO o FROM otl.interest_outbox WHERE team_id=t AND available_at<=now_at
      AND (status IN ('pending','failed') OR status='claimed')
      AND attempts<5 ORDER BY available_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
    UPDATE otl.interest_outbox SET status='claimed',attempts=attempts+1,
      claim_key=k,available_at=now_at+interval '5 minutes'
      WHERE outbox_id=o.outbox_id RETURNING * INTO o;
    RETURN jsonb_build_object('outboxId',o.outbox_id,'interestId',o.interest_id,
      'revision',(SELECT revision FROM otl.interest_requests WHERE team_id=t AND interest_id=o.interest_id),
      'state',(SELECT state FROM otl.interest_requests WHERE team_id=t AND interest_id=o.interest_id),
      'effectKey',o.effect_key,'effectType',o.effect_type,'claimKey',k,
      'opaqueRef',(SELECT opaque_ref FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=o.interest_id),
      'objectDigest',(SELECT object_digest FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=o.interest_id),
      'envelopeDek',(SELECT envelope_dek FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=o.interest_id),
      'nonce',(SELECT nonce FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=o.interest_id),
      'keyVersion',(SELECT key_version FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=o.interest_id),
      'schemaVersion','interest-application.v1',
      'shareNameEmailWithIntroducer',(SELECT share_name_email_with_introducer FROM otl.interest_consents WHERE team_id=t AND interest_id=o.interest_id));
  ELSIF op='finish' THEN
    IF p->>'status' NOT IN ('sent','failed') OR coalesce(p->>'outboxId','') !~ '^[0-9]+$'
    THEN RAISE EXCEPTION 'invalid delivery result'; END IF;
    SELECT * INTO o FROM otl.interest_outbox WHERE team_id=t
      AND outbox_id=(p->>'outboxId')::bigint FOR UPDATE;
    IF NOT FOUND OR o.status<>'claimed' OR o.claim_key<>k
    THEN RAISE EXCEPTION 'delivery claim unavailable'; END IF;
    UPDATE otl.interest_outbox SET status=CASE WHEN p->>'status'='failed' AND attempts>=5
        THEN 'dead' ELSE p->>'status' END,
      available_at=CASE WHEN p->>'status'='failed' THEN now_at+interval '5 minutes' ELSE available_at END
      WHERE outbox_id=o.outbox_id RETURNING * INTO o;
    RETURN jsonb_build_object('outboxId',o.outbox_id,'status',o.status);
  END IF;
  RAISE EXCEPTION 'unsupported interest delivery operation';
END $$;

CREATE FUNCTION otl.interest_retention_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; k text:=p->>'key'; now_at timestamptz;
  batch integer; processed integer:=0; i otl.interest_requests;
  payload otl.interest_private_payloads; result jsonb;
BEGIN
  IF coalesce(t,'')='' OR coalesce(p->>'now','')=''
  THEN RAISE EXCEPTION 'invalid interest retention'; END IF;
  now_at:=(p->>'now')::timestamptz;
  batch:=least(greatest(coalesce((p->>'limit')::integer,10),1),10);
  IF op='expire_due' THEN
    FOR i IN SELECT * FROM otl.interest_requests WHERE team_id=t
      AND state IN ('pending_introduction','introduction_verified') AND payload_purge_after<=now_at
      ORDER BY payload_purge_after,interest_id LIMIT batch FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE otl.interest_requests SET state='expired',revision=revision+1,terminal_at=now_at
        WHERE team_id=t AND interest_id=i.interest_id;
      UPDATE otl.interest_outbox SET status='cancelled' WHERE team_id=t AND interest_id=i.interest_id
        AND status IN ('pending','failed');
      INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,
        from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
        VALUES(t,i.interest_id,'expire:'||i.revision,'expired','retention',i.state,'expired',
          md5(i.interest_id||':'||i.revision),now_at,i.audit_purge_after,
          jsonb_build_object('interestId',i.interest_id,'state','expired'));
      processed:=processed+1;
    END LOOP;
    RETURN jsonb_build_object('processed',processed);
  ELSIF op='claim_purge' THEN
    IF coalesce(k,'')='' THEN RAISE EXCEPTION 'purge key required'; END IF;
    SELECT pp.* INTO payload FROM otl.interest_private_payloads pp
      JOIN otl.interest_requests ir USING(team_id,interest_id)
      WHERE pp.team_id=t AND ir.payload_purge_after<=now_at
        AND pp.purge_status IN ('pending','failed','claimed')
        AND (pp.purge_retry_at IS NULL OR pp.purge_retry_at<=now_at)
        AND pp.purge_attempts<5
      ORDER BY ir.payload_purge_after,pp.interest_id FOR UPDATE OF pp SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
    UPDATE otl.interest_private_payloads SET purge_status='claimed',
      purge_attempts=purge_attempts+1,purge_claim_key=k,purge_retry_at=now_at+interval '5 minutes'
      WHERE team_id=t AND interest_id=payload.interest_id RETURNING * INTO payload;
    INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
      SELECT t,ir.interest_id,'purge-claim:'||k,'payload_purge_claimed','retention',ir.state,
        ir.state,md5(k),now_at,ir.audit_purge_after,
        jsonb_build_object('interestId',ir.interest_id,'attempt',payload.purge_attempts)
      FROM otl.interest_requests ir WHERE ir.team_id=t AND ir.interest_id=payload.interest_id;
    RETURN jsonb_build_object('interestId',payload.interest_id,'opaqueRef',payload.opaque_ref,
      'objectDigest',payload.object_digest,'claimKey',k);
  ELSIF op='finish_purge' THEN
    IF coalesce(k,'')='' OR coalesce(p->>'interestId','')='' OR p->>'status' NOT IN ('purged','failed')
    THEN RAISE EXCEPTION 'invalid purge result'; END IF;
    SELECT * INTO payload FROM otl.interest_private_payloads WHERE team_id=t
      AND interest_id=p->>'interestId' FOR UPDATE;
    IF NOT FOUND OR payload.purge_status<>'claimed' OR payload.purge_claim_key<>k
    THEN RAISE EXCEPTION 'purge claim unavailable'; END IF;
    IF p->>'status'='purged' THEN
      UPDATE otl.interest_private_payloads SET purge_status='purged',envelope_dek=NULL,nonce=NULL,
        purged_at=now_at,purge_retry_at=NULL WHERE team_id=t AND interest_id=payload.interest_id;
    ELSE
      UPDATE otl.interest_private_payloads SET purge_status=CASE WHEN purge_attempts>=5 THEN 'dead' ELSE 'failed' END,
        purge_retry_at=now_at+interval '5 minutes' WHERE team_id=t AND interest_id=payload.interest_id;
    END IF;
    SELECT * INTO i FROM otl.interest_requests WHERE team_id=t AND interest_id=payload.interest_id;
    result:=jsonb_build_object('interestId',payload.interest_id,'status',
      (SELECT purge_status FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=payload.interest_id));
    INSERT INTO otl.interest_events(team_id,interest_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
      VALUES(t,i.interest_id,'purge-finish:'||k,CASE result->>'status'
        WHEN 'purged' THEN 'payload_purged' WHEN 'dead' THEN 'payload_purge_dead'
        ELSE 'payload_purge_failed' END,'retention',i.state,i.state,md5(p::text),now_at,
        i.audit_purge_after,result);
    RETURN result;
  ELSIF op='audit_retention' THEN
    PERFORM set_config('otl.interest_retention','enabled',true);
    FOR i IN SELECT * FROM otl.interest_requests ir WHERE ir.team_id=t
      AND ir.audit_purge_after<=now_at AND ir.state IN ('attached','withdrawn','declined','expired')
      AND EXISTS(SELECT 1 FROM otl.interest_private_payloads pp WHERE pp.team_id=t
        AND pp.interest_id=ir.interest_id AND pp.purge_status='purged')
      ORDER BY ir.audit_purge_after,ir.interest_id LIMIT batch FOR UPDATE SKIP LOCKED
    LOOP
      DELETE FROM otl.interest_outbox WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_events WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_referral_bridges WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_introduction_prompts WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_introduction_evidence WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_attachment_consents WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_consents WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_submission_receipts WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_private_payloads WHERE team_id=t AND interest_id=i.interest_id;
      DELETE FROM otl.interest_requests WHERE team_id=t AND interest_id=i.interest_id;
      processed:=processed+1;
    END LOOP;
    DELETE FROM otl.interest_service_nonces WHERE team_id=t AND expires_at<=now_at;
    DELETE FROM otl.interest_submission_receipts WHERE team_id=t AND interest_id IS NULL
      AND recorded_at<=now_at-interval '12 months';
    PERFORM set_config('otl.interest_retention','',true);
    RETURN jsonb_build_object('processed',processed);
  END IF;
  RAISE EXCEPTION 'unsupported interest retention operation';
END $$;

REVOKE ALL ON TABLE otl.interest_requests,otl.interest_consents,otl.interest_attachment_consents,otl.interest_private_payloads,
  otl.interest_submission_receipts,otl.interest_introduction_evidence,otl.interest_referral_bridges,
  otl.interest_events,otl.interest_outbox,otl.interest_introduction_prompts,otl.interest_service_nonces FROM PUBLIC,otl_referral_runtime,otl_referral_admin,otl_interest_member;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM PUBLIC,otl_referral_runtime,otl_referral_admin,otl_interest_member;
REVOKE ALL ON FUNCTION otl.interest_identity_guard(),otl.interest_payload_identity_guard(),
  otl.interest_audit_guard(),otl.interest_referral_guard(),otl.interest_member_active(text,text),
  otl.interest_receipt(otl.interest_requests),otl.interest_runtime_execute(text,jsonb),
  otl.interest_admin_execute(text,jsonb),otl.interest_member_confirm(jsonb),
  otl.interest_delivery_execute(text,jsonb),otl.interest_retention_execute(text,jsonb)
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin,otl_interest_member;
GRANT EXECUTE ON FUNCTION otl.interest_runtime_execute(text,jsonb),
  otl.interest_retention_execute(text,jsonb) TO otl_referral_runtime;
GRANT EXECUTE ON FUNCTION otl.interest_admin_execute(text,jsonb),
  otl.interest_delivery_execute(text,jsonb) TO otl_referral_admin;
GRANT EXECUTE ON FUNCTION otl.interest_member_confirm(jsonb) TO otl_interest_member;
INSERT INTO otl.schema_migrations(version) VALUES('037-interest-requests');
COMMIT;
