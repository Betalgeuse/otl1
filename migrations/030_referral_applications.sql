BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:referral-applications:030',0));

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_referral_runtime') THEN
    CREATE ROLE otl_referral_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_referral_admin') THEN
    CREATE ROLE otl_referral_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
ALTER ROLE otl_referral_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE otl_referral_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
DO $$ DECLARE membership record; BEGIN
  FOR membership IN
    SELECT parent.rolname parent_name,member.rolname member_name
    FROM pg_auth_members am JOIN pg_roles parent ON parent.oid=am.roleid
    JOIN pg_roles member ON member.oid=am.member
    WHERE member.rolname IN ('otl_referral_runtime','otl_referral_admin')
  LOOP EXECUTE format('REVOKE %I FROM %I',membership.parent_name,membership.member_name); END LOOP;
END $$;
REVOKE ALL ON SCHEMA otl FROM otl_referral_runtime,otl_referral_admin;
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM otl_referral_runtime,otl_referral_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM otl_referral_runtime,otl_referral_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otl FROM otl_referral_runtime,otl_referral_admin;
GRANT USAGE ON SCHEMA otl TO otl_referral_runtime,otl_referral_admin;

CREATE TABLE otl.member_referral_links (
  team_id text NOT NULL,
  link_id text NOT NULL CHECK(link_id~'^LNK-[A-Z0-9]{4,64}$'),
  referrer_user_id text NOT NULL,
  token_digest text NOT NULL CHECK(token_digest~'^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN ('active','paused','revoked')),
  created_at timestamptz NOT NULL,
  status_changed_at timestamptz NOT NULL,
  rotated_from_link_id text,
  PRIMARY KEY(team_id,link_id),
  UNIQUE(team_id,token_digest),
  FOREIGN KEY(team_id,referrer_user_id) REFERENCES otl.workspace_members(team_id,user_id),
  FOREIGN KEY(team_id,rotated_from_link_id) REFERENCES otl.member_referral_links(team_id,link_id),
  CHECK(status_changed_at>=created_at)
);
CREATE UNIQUE INDEX member_referral_links_one_current
  ON otl.member_referral_links(team_id,referrer_user_id) WHERE status IN ('active','paused');

CREATE TABLE otl.referral_admins (
  team_id text NOT NULL,
  user_id text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(team_id,user_id),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id)
);

CREATE TABLE otl.referral_requests (
  team_id text NOT NULL,
  request_id text NOT NULL CHECK(request_id~'^REQ-[A-Z0-9-]{4,64}$'),
  receipt_id text NOT NULL CHECK(receipt_id~'^RCP-[A-Z0-9-]{4,64}$'),
  link_id text NOT NULL,
  referrer_user_id text NOT NULL,
  email_digest text NOT NULL CHECK(email_digest~'^[0-9a-f]{64}$'),
  withdrawal_digest text NOT NULL CHECK(withdrawal_digest~'^[0-9a-f]{64}$'),
  state text NOT NULL CHECK(state IN (
    'pending','approved','declined','duplicate','withdrawn','suspected_abuse','expired','joined'
  )),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  submission_key text NOT NULL CHECK(btrim(submission_key)<>''),
  submission_hash text NOT NULL CHECK(submission_hash~'^[0-9a-f]{32}$'),
  submitted_at timestamptz NOT NULL,
  terminal_at timestamptz,
  payload_purge_after timestamptz NOT NULL,
  audit_purge_after timestamptz NOT NULL,
  PRIMARY KEY(team_id,request_id),
  UNIQUE(team_id,receipt_id),
  UNIQUE(team_id,submission_key),
  FOREIGN KEY(team_id,link_id) REFERENCES otl.member_referral_links(team_id,link_id),
  FOREIGN KEY(team_id,referrer_user_id) REFERENCES otl.workspace_members(team_id,user_id),
  CHECK((state IN ('pending','approved'))=(terminal_at IS NULL)),
  CHECK(payload_purge_after>=submitted_at),
  CHECK(audit_purge_after>=payload_purge_after)
);
CREATE UNIQUE INDEX referral_requests_one_open_email
  ON otl.referral_requests(team_id,email_digest) WHERE state IN ('pending','approved');

CREATE TABLE otl.referral_consents (
  team_id text NOT NULL,
  request_id text NOT NULL,
  consent_version text NOT NULL CHECK(consent_version='invite-consent-v1'),
  consented_at timestamptz NOT NULL,
  PRIMARY KEY(team_id,request_id),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id)
);

CREATE TABLE otl.referral_submission_receipts (
  team_id text NOT NULL,
  submission_key text NOT NULL CHECK(btrim(submission_key)<>''),
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{32}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(team_id,submission_key),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id)
);

CREATE TABLE otl.referral_private_payloads (
  team_id text NOT NULL,
  request_id text NOT NULL,
  opaque_ref text NOT NULL CHECK(opaque_ref~'^invite-private/REQ-[A-Z0-9-]{4,64}/'),
  object_digest text NOT NULL CHECK(object_digest~'^[0-9a-f]{64}$'),
  envelope_dek text,
  nonce text,
  key_version text NOT NULL CHECK(key_version~'^[a-z0-9][a-z0-9._-]{0,63}$'),
  schema_version text NOT NULL CHECK(schema_version='invite-application.v1'),
  purge_status text NOT NULL DEFAULT 'pending' CHECK(purge_status IN ('pending','claimed','failed','purged')),
  purge_attempts integer NOT NULL DEFAULT 0 CHECK(purge_attempts>=0),
  purge_claim_key text,
  purge_retry_at timestamptz,
  purged_at timestamptz,
  PRIMARY KEY(team_id,request_id),
  UNIQUE(opaque_ref),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id),
  CHECK((purge_status='purged')=(purged_at IS NOT NULL)),
  CHECK(purge_status='purged' OR (envelope_dek IS NOT NULL AND nonce IS NOT NULL))
);

CREATE TABLE otl.referral_request_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  request_id text NOT NULL,
  event_key text NOT NULL CHECK(btrim(event_key)<>''),
  event_type text NOT NULL CHECK(event_type IN (
    'submitted','withdrawn','approved','declined','duplicate','suspected_abuse',
    'manual_invite_asserted','joined','expired','payload_purge_claimed','payload_purged','payload_purge_failed'
  )),
  actor_class text NOT NULL CHECK(actor_class IN ('applicant','admin','runtime','retention')),
  actor_id text,
  from_state text,
  to_state text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{32}$'),
  occurred_at timestamptz NOT NULL,
  audit_purge_after timestamptz NOT NULL,
  result jsonb NOT NULL,
  UNIQUE(team_id,request_id,event_key),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id)
);

CREATE TABLE otl.referral_decisions (
  decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  request_id text NOT NULL,
  decision_code text NOT NULL CHECK(decision_code IN (
    'approved','declined','duplicate','withdrawn','suspected_abuse'
  )),
  decided_by text,
  decided_at timestamptz NOT NULL,
  event_key text NOT NULL,
  UNIQUE(team_id,request_id,event_key),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id),
  FOREIGN KEY(team_id,decided_by) REFERENCES otl.workspace_members(team_id,user_id)
);

CREATE TABLE otl.referral_manual_invite_assertions (
  team_id text NOT NULL,
  request_id text NOT NULL,
  asserted_by text NOT NULL,
  asserted_at timestamptz NOT NULL,
  event_key text NOT NULL,
  PRIMARY KEY(team_id,request_id),
  UNIQUE(team_id,request_id,event_key),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id),
  FOREIGN KEY(team_id,asserted_by) REFERENCES otl.workspace_members(team_id,user_id)
);

CREATE TABLE otl.member_referral_attributions (
  team_id text NOT NULL,
  introduced_user_id text NOT NULL,
  referrer_user_id text NOT NULL,
  request_id text NOT NULL,
  joined_at timestamptz NOT NULL,
  slack_event_id text NOT NULL CHECK(btrim(slack_event_id)<>''),
  PRIMARY KEY(team_id,introduced_user_id),
  UNIQUE(team_id,request_id),
  UNIQUE(team_id,slack_event_id),
  FOREIGN KEY(team_id,introduced_user_id) REFERENCES otl.workspace_members(team_id,user_id),
  FOREIGN KEY(team_id,referrer_user_id) REFERENCES otl.workspace_members(team_id,user_id),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id)
);

CREATE TABLE otl.referral_outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  request_id text NOT NULL,
  effect_key text NOT NULL,
  effect_type text NOT NULL CHECK(effect_type IN ('admin_review','admin_decision','request_withdrawn','join_observed')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','sent','failed','cancelled')),
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  UNIQUE(team_id,effect_key),
  FOREIGN KEY(team_id,request_id) REFERENCES otl.referral_requests(team_id,request_id)
);

CREATE FUNCTION otl.referral_audit_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN RAISE EXCEPTION 'referral audit rows are immutable'; END $$;
CREATE FUNCTION otl.referral_link_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF
    NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.link_id IS DISTINCT FROM OLD.link_id OR
    NEW.referrer_user_id IS DISTINCT FROM OLD.referrer_user_id OR
    NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.rotated_from_link_id IS DISTINCT FROM OLD.rotated_from_link_id
  THEN RAISE EXCEPTION 'referral identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION otl.referral_request_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF
    NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
    NEW.receipt_id IS DISTINCT FROM OLD.receipt_id OR NEW.link_id IS DISTINCT FROM OLD.link_id OR
    NEW.referrer_user_id IS DISTINCT FROM OLD.referrer_user_id OR NEW.email_digest IS DISTINCT FROM OLD.email_digest OR
    NEW.withdrawal_digest IS DISTINCT FROM OLD.withdrawal_digest OR
    NEW.submission_key IS DISTINCT FROM OLD.submission_key OR NEW.submission_hash IS DISTINCT FROM OLD.submission_hash OR
    NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.audit_purge_after IS DISTINCT FROM OLD.audit_purge_after
  THEN RAISE EXCEPTION 'referral identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION otl.referral_payload_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF
    NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
    NEW.opaque_ref IS DISTINCT FROM OLD.opaque_ref OR NEW.object_digest IS DISTINCT FROM OLD.object_digest OR
    NEW.key_version IS DISTINCT FROM OLD.key_version OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
  THEN RAISE EXCEPTION 'referral identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_links_identity_immutable BEFORE UPDATE ON otl.member_referral_links
  FOR EACH ROW EXECUTE FUNCTION otl.referral_link_identity_immutable();
CREATE TRIGGER referral_requests_identity_immutable BEFORE UPDATE ON otl.referral_requests
  FOR EACH ROW EXECUTE FUNCTION otl.referral_request_identity_immutable();
CREATE TRIGGER referral_payloads_identity_immutable BEFORE UPDATE ON otl.referral_private_payloads
  FOR EACH ROW EXECUTE FUNCTION otl.referral_payload_identity_immutable();
CREATE TRIGGER referral_events_immutable BEFORE UPDATE OR DELETE ON otl.referral_request_events
  FOR EACH ROW EXECUTE FUNCTION otl.referral_audit_immutable();
CREATE TRIGGER referral_decisions_immutable BEFORE UPDATE OR DELETE ON otl.referral_decisions
  FOR EACH ROW EXECUTE FUNCTION otl.referral_audit_immutable();
CREATE TRIGGER referral_consents_immutable BEFORE UPDATE OR DELETE ON otl.referral_consents
  FOR EACH ROW EXECUTE FUNCTION otl.referral_audit_immutable();
CREATE TRIGGER referral_assertions_immutable BEFORE UPDATE OR DELETE ON otl.referral_manual_invite_assertions
  FOR EACH ROW EXECUTE FUNCTION otl.referral_audit_immutable();
CREATE TRIGGER referral_attributions_immutable BEFORE UPDATE OR DELETE ON otl.member_referral_attributions
  FOR EACH ROW EXECUTE FUNCTION otl.referral_audit_immutable();

CREATE FUNCTION otl.referral_receipt(r otl.referral_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
  SELECT jsonb_build_object('receiptId',r.receipt_id,'state',r.state,'revision',r.revision)
$$;

CREATE FUNCTION otl.referral_runtime_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; u text:=p->>'userId'; now_at timestamptz;
  digest text:=p->>'tokenDigest'; email_hash text:=p->>'emailDigest'; key text:=p->>'key';
  link otl.member_referral_links; request otl.referral_requests; event otl.referral_request_events;
  submission otl.referral_submission_receipts;
  payload otl.referral_private_payloads; request_hash text:=md5(p::text); old_state text;
BEGIN
  IF coalesce(t,'')='' THEN RAISE EXCEPTION 'referral scope required'; END IF;
  IF op='resolve' THEN
    IF coalesce(digest,'') !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('available',false);
    END IF;
    SELECT * INTO link FROM otl.member_referral_links WHERE team_id=t AND token_digest=digest AND status='active';
    RETURN jsonb_build_object('available',FOUND);
  END IF;
  IF coalesce(p->>'now','')='' THEN RAISE EXCEPTION 'referral clock required'; END IF;
  now_at:=(p->>'now')::timestamptz;

  IF op IN ('issue','rotate','set_status') THEN
    IF coalesce(u,'')='' THEN RAISE EXCEPTION 'referral member required'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,u)::text,30));
    IF op='set_status' THEN
      SELECT * INTO link FROM otl.member_referral_links
        WHERE team_id=t AND referrer_user_id=u AND status IN ('active','paused') FOR UPDATE;
      IF NOT FOUND OR p->>'status' NOT IN ('active','paused','revoked') THEN RAISE EXCEPTION 'invalid referral status'; END IF;
      IF p->>'status'='active' AND NOT EXISTS(
        SELECT 1 FROM otl.member_lifecycles l
        JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
        JOIN otl.workspace_members m USING(team_id,user_id)
        WHERE l.team_id=t AND l.user_id=u AND l.state='active' AND cm.is_current
          AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false)
          AND NOT coalesce(m.slack_deleted,false)
      ) THEN RAISE EXCEPTION 'referral member unavailable'; END IF;
      UPDATE otl.member_referral_links SET status=p->>'status',status_changed_at=now_at
        WHERE team_id=t AND link_id=link.link_id RETURNING * INTO link;
      RETURN jsonb_build_object('linkId',link.link_id,'status',link.status,'created',false);
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM otl.member_lifecycles l
      JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
      JOIN otl.workspace_members m USING(team_id,user_id)
      WHERE l.team_id=t AND l.user_id=u AND l.state='active' AND cm.is_current
        AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false)
        AND NOT coalesce(m.slack_deleted,false)
    ) THEN RAISE EXCEPTION 'referral member unavailable'; END IF;
    SELECT * INTO link FROM otl.member_referral_links
      WHERE team_id=t AND referrer_user_id=u AND status IN ('active','paused') FOR UPDATE;
    IF op='issue' AND FOUND THEN
      IF link.status='paused' THEN
        UPDATE otl.member_referral_links SET status='active',status_changed_at=now_at
          WHERE team_id=t AND link_id=link.link_id RETURNING * INTO link;
      END IF;
      RETURN jsonb_build_object('linkId',link.link_id,'status',link.status,'created',false);
    END IF;
    IF coalesce(p->>'linkId','') !~ '^LNK-[A-Z0-9]{4,64}$' OR coalesce(digest,'') !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid referral token'; END IF;
    IF FOUND THEN
      UPDATE otl.member_referral_links SET status='revoked',status_changed_at=now_at
        WHERE team_id=t AND link_id=link.link_id;
    END IF;
    INSERT INTO otl.member_referral_links(team_id,link_id,referrer_user_id,token_digest,status,
      created_at,status_changed_at,rotated_from_link_id)
    VALUES(t,p->>'linkId',u,digest,'active',now_at,now_at,link.link_id) RETURNING * INTO link;
    RETURN jsonb_build_object('linkId',link.link_id,'status','active','created',true);
  END IF;

  IF op='submit' THEN
    IF coalesce(email_hash,'') !~ '^[0-9a-f]{64}$' OR coalesce(digest,'') !~ '^[0-9a-f]{64}$'
      OR p->>'consentVersion'<>'invite-consent-v1' OR coalesce(p->>'requestId','') !~ '^REQ-[A-Z0-9-]{4,64}$'
      OR coalesce(p->>'receiptId','') !~ '^RCP-[A-Z0-9-]{4,64}$'
      OR coalesce(p->>'withdrawalDigest','') !~ '^[0-9a-f]{64}$' OR coalesce(key,'')=''
      OR coalesce(p->>'objectDigest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p->>'opaqueRef','') !~ '^invite-private/REQ-[A-Z0-9-]{4,64}/'
      OR coalesce(p->>'keyVersion','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      OR coalesce(p->>'envelopeDek','')='' OR coalesce(p->>'nonce','')=''
    THEN RAISE EXCEPTION 'invalid referral request'; END IF;
    IF (p->>'consentedAt')::timestamptz>now_at THEN RAISE EXCEPTION 'invalid referral consent'; END IF;
    SELECT * INTO submission FROM otl.referral_submission_receipts WHERE team_id=t AND submission_key=key;
    IF FOUND THEN
      IF submission.request_hash<>request_hash THEN RAISE EXCEPTION 'referral idempotency collision'; END IF;
      SELECT * INTO request FROM otl.referral_requests
        WHERE team_id=t AND request_id=submission.request_id;
      RETURN otl.referral_receipt(request);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,email_hash)::text,30));
    SELECT * INTO request FROM otl.referral_requests
      WHERE team_id=t AND email_digest=email_hash AND state IN ('pending','approved') FOR UPDATE;
    IF FOUND THEN
      INSERT INTO otl.referral_submission_receipts(team_id,submission_key,request_id,request_hash,recorded_at)
        VALUES(t,key,request.request_id,request_hash,now_at);
      RETURN otl.referral_receipt(request);
    END IF;
    SELECT * INTO link FROM otl.member_referral_links
      WHERE team_id=t AND token_digest=digest AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'referral unavailable'; END IF;
    INSERT INTO otl.referral_requests(team_id,request_id,receipt_id,link_id,referrer_user_id,
      email_digest,withdrawal_digest,state,submission_key,
      submission_hash,submitted_at,payload_purge_after,audit_purge_after)
    VALUES(t,p->>'requestId',p->>'receiptId',link.link_id,link.referrer_user_id,email_hash,
      p->>'withdrawalDigest','pending',key,
      request_hash,now_at,now_at+interval '30 days',now_at+interval '12 months') RETURNING * INTO request;
    INSERT INTO otl.referral_consents(team_id,request_id,consent_version,consented_at)
      VALUES(t,request.request_id,'invite-consent-v1',(p->>'consentedAt')::timestamptz);
    INSERT INTO otl.referral_submission_receipts(team_id,submission_key,request_id,request_hash,recorded_at)
      VALUES(t,key,request.request_id,request_hash,now_at);
    INSERT INTO otl.referral_private_payloads(team_id,request_id,opaque_ref,object_digest,
      envelope_dek,nonce,key_version,schema_version)
    VALUES(t,request.request_id,p->>'opaqueRef',p->>'objectDigest',p->>'envelopeDek',p->>'nonce',
      p->>'keyVersion','invite-application.v1');
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,key,'submitted','applicant',NULL,'pending',request_hash,now_at,
      now_at+interval '12 months',otl.referral_receipt(request));
    INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
    VALUES(t,request.request_id,'review:'||request.request_id,'admin_review',now_at);
    RETURN otl.referral_receipt(request);
  END IF;

  IF op='withdraw' THEN
    IF coalesce(p->>'receiptId','')='' OR coalesce(p->>'withdrawalDigest','') !~ '^[0-9a-f]{64}$' OR coalesce(key,'')=''
    THEN RAISE EXCEPTION 'invalid withdrawal'; END IF;
    SELECT * INTO request FROM otl.referral_requests
      WHERE team_id=t AND receipt_id=p->>'receiptId' AND withdrawal_digest=p->>'withdrawalDigest' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'request unavailable'; END IF;
    SELECT * INTO event FROM otl.referral_request_events
      WHERE team_id=t AND request_id=request.request_id AND event_key=key;
    IF FOUND THEN
      IF event.request_hash<>request_hash THEN RAISE EXCEPTION 'referral idempotency collision'; END IF;
      RETURN event.result;
    END IF;
    IF request.state NOT IN ('pending','approved') THEN RAISE EXCEPTION 'request is terminal'; END IF;
    old_state:=request.state;
    UPDATE otl.referral_requests SET state='withdrawn',revision=revision+1,terminal_at=now_at,
      payload_purge_after=now_at+interval '24 hours'
      WHERE team_id=t AND request_id=request.request_id RETURNING * INTO request;
    INSERT INTO otl.referral_decisions(team_id,request_id,decision_code,decided_at,event_key)
      VALUES(t,request.request_id,'withdrawn',now_at,key);
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,key,'withdrawn','applicant',old_state,'withdrawn',request_hash,now_at,
      now_at+interval '12 months',otl.referral_receipt(request));
    UPDATE otl.referral_outbox SET status='cancelled' WHERE team_id=t AND request_id=request.request_id AND status='pending';
    INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
      VALUES(t,request.request_id,'withdrawn:'||request.request_id,'request_withdrawn',now_at);
    RETURN otl.referral_receipt(request);
  END IF;

  IF op='attribute_join' THEN
    IF coalesce(email_hash,'') !~ '^[0-9a-f]{64}$' OR coalesce(u,'')='' OR coalesce(p->>'eventId','')=''
    THEN RAISE EXCEPTION 'invalid join attribution'; END IF;
    SELECT r.* INTO request FROM otl.member_referral_attributions a
      JOIN otl.referral_requests r USING(team_id,request_id)
      WHERE a.team_id=t AND a.slack_event_id=p->>'eventId';
    IF FOUND THEN RETURN otl.referral_receipt(request); END IF;
    IF NOT EXISTS(SELECT 1 FROM otl.workspace_members m WHERE m.team_id=t AND m.user_id=u
      AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false))
    THEN RAISE EXCEPTION 'joined member unavailable'; END IF;
    SELECT * INTO request FROM otl.referral_requests r
      WHERE r.team_id=t AND r.email_digest=email_hash AND r.state='approved'
        AND EXISTS(SELECT 1 FROM otl.referral_manual_invite_assertions a
          WHERE a.team_id=r.team_id AND a.request_id=r.request_id) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'approved request unavailable'; END IF;
    INSERT INTO otl.member_referral_attributions(team_id,introduced_user_id,referrer_user_id,
      request_id,joined_at,slack_event_id)
    VALUES(t,u,request.referrer_user_id,request.request_id,now_at,p->>'eventId')
    ON CONFLICT(team_id,slack_event_id) DO NOTHING;
    IF NOT FOUND THEN RETURN otl.referral_receipt(request); END IF;
    UPDATE otl.referral_requests SET state='joined',revision=revision+1,terminal_at=now_at,
      payload_purge_after=now_at+interval '7 days'
      WHERE team_id=t AND request_id=request.request_id RETURNING * INTO request;
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      actor_id,from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,'join:'||(p->>'eventId'),'joined','runtime',u,'approved','joined',
      request_hash,now_at,now_at+interval '12 months',otl.referral_receipt(request));
    INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
      VALUES(t,request.request_id,'join:'||(p->>'eventId'),'join_observed',now_at) ON CONFLICT DO NOTHING;
    RETURN otl.referral_receipt(request);
  END IF;

  IF op='claim_purge' THEN
    SELECT pp.* INTO payload FROM otl.referral_private_payloads pp
      JOIN otl.referral_requests r USING(team_id,request_id)
      WHERE pp.team_id=t AND r.payload_purge_after<=now_at
        AND (pp.purge_status IN ('pending','failed') OR (pp.purge_status='claimed' AND pp.purge_retry_at<=now_at))
        AND (pp.purge_retry_at IS NULL OR pp.purge_retry_at<=now_at)
      ORDER BY r.payload_purge_after,pp.request_id FOR UPDATE OF pp SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
    key:=coalesce(p->>'key','purge:'||payload.request_id||':'||(payload.purge_attempts+1));
    UPDATE otl.referral_private_payloads SET purge_status='claimed',purge_attempts=purge_attempts+1,
      purge_claim_key=key,purge_retry_at=now_at+interval '5 minutes'
      WHERE team_id=t AND request_id=payload.request_id RETURNING * INTO payload;
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    SELECT t,r.request_id,key,'payload_purge_claimed','retention',r.state,r.state,request_hash,now_at,
      now_at+interval '12 months',jsonb_build_object('requestId',r.request_id,'attempt',payload.purge_attempts)
      FROM otl.referral_requests r WHERE r.team_id=t AND r.request_id=payload.request_id;
    RETURN jsonb_build_object('requestId',payload.request_id,'opaqueRef',payload.opaque_ref,
      'objectDigest',payload.object_digest,'envelopeDek',payload.envelope_dek,'nonce',payload.nonce,
      'keyVersion',payload.key_version,'schemaVersion',payload.schema_version,'claimKey',key);
  END IF;

  IF op='finish_purge' THEN
    IF p->>'status' NOT IN ('purged','failed') OR coalesce(p->>'requestId','')='' OR coalesce(key,'')=''
    THEN RAISE EXCEPTION 'invalid purge result'; END IF;
    SELECT pp.* INTO payload FROM otl.referral_private_payloads pp
      WHERE pp.team_id=t AND pp.request_id=p->>'requestId' FOR UPDATE;
    IF FOUND AND payload.purge_claim_key=key AND payload.purge_status=p->>'status' THEN
      RETURN jsonb_build_object('requestId',payload.request_id,'status',payload.purge_status);
    END IF;
    IF NOT FOUND OR payload.purge_status<>'claimed' OR payload.purge_claim_key<>key
    THEN RAISE EXCEPTION 'purge claim unavailable'; END IF;
    IF p->>'status'='purged' THEN
      UPDATE otl.referral_private_payloads SET purge_status='purged',envelope_dek=NULL,nonce=NULL,
        purged_at=now_at,purge_retry_at=NULL WHERE team_id=t AND request_id=payload.request_id;
    ELSE
      UPDATE otl.referral_private_payloads SET purge_status='failed',purge_retry_at=now_at+interval '15 minutes'
        WHERE team_id=t AND request_id=payload.request_id;
    END IF;
    SELECT * INTO request FROM otl.referral_requests WHERE team_id=t AND request_id=payload.request_id;
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,key||':'||(p->>'status'),
      CASE WHEN p->>'status'='purged' THEN 'payload_purged' ELSE 'payload_purge_failed' END,
      'retention',request.state,request.state,request_hash,now_at,now_at+interval '12 months',
      jsonb_build_object('requestId',request.request_id,'status',p->>'status'));
    RETURN jsonb_build_object('requestId',request.request_id,'status',p->>'status');
  END IF;
  RAISE EXCEPTION 'invalid referral runtime operation';
END $$;

CREATE FUNCTION otl.referral_admin_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; admin_id text:=p->>'adminId'; key text:=p->>'key';
  now_at timestamptz; request otl.referral_requests; event otl.referral_request_events;
  request_hash text:=md5(p::text); code text:=p->>'decision'; expected integer; result jsonb; old_state text;
BEGIN
  IF coalesce(t,'')='' OR coalesce(admin_id,'')='' OR
    NOT EXISTS(SELECT 1 FROM otl.referral_admins WHERE team_id=t AND user_id=admin_id)
  THEN RAISE EXCEPTION 'referral admin denied'; END IF;
  IF coalesce(p->>'now','')='' OR coalesce(p->>'requestId','')='' OR coalesce(key,'')=''
  THEN RAISE EXCEPTION 'invalid referral admin request'; END IF;
  now_at:=(p->>'now')::timestamptz;
  SELECT * INTO request FROM otl.referral_requests WHERE team_id=t AND request_id=p->>'requestId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral request unavailable'; END IF;
  SELECT * INTO event FROM otl.referral_request_events
    WHERE team_id=t AND request_id=request.request_id AND event_key=key;
  IF FOUND THEN
    IF event.request_hash<>request_hash THEN RAISE EXCEPTION 'referral idempotency collision'; END IF;
    RETURN event.result;
  END IF;
  IF coalesce(p->>'expectedRevision','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'referral revision required'; END IF;
  expected:=(p->>'expectedRevision')::integer;
  IF request.revision<>expected THEN RAISE EXCEPTION 'stale referral revision'; END IF;

  IF op='decide' THEN
    IF request.state<>'pending' OR code NOT IN ('approved','declined','duplicate','suspected_abuse')
    THEN RAISE EXCEPTION 'invalid referral decision'; END IF;
    UPDATE otl.referral_requests SET state=code,revision=revision+1,
      terminal_at=CASE WHEN code='approved' THEN NULL ELSE now_at END,
      payload_purge_after=CASE WHEN code='approved' THEN payload_purge_after ELSE now_at+interval '24 hours' END
      WHERE team_id=t AND request_id=request.request_id RETURNING * INTO request;
    INSERT INTO otl.referral_decisions(team_id,request_id,decision_code,decided_by,decided_at,event_key)
      VALUES(t,request.request_id,code,admin_id,now_at,key);
    result:=otl.referral_receipt(request);
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      actor_id,from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,key,code,'admin',admin_id,'pending',code,request_hash,now_at,
      now_at+interval '12 months',result);
    INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
      VALUES(t,request.request_id,'decision:'||key,'admin_decision',now_at);
    RETURN result;
  END IF;

  IF op='mark_invited' THEN
    IF request.state<>'approved' THEN RAISE EXCEPTION 'request is not approved'; END IF;
    INSERT INTO otl.referral_manual_invite_assertions(team_id,request_id,asserted_by,asserted_at,event_key)
      VALUES(t,request.request_id,admin_id,now_at,key);
    UPDATE otl.referral_requests SET revision=revision+1
      WHERE team_id=t AND request_id=request.request_id RETURNING * INTO request;
    result:=otl.referral_receipt(request)||jsonb_build_object('manualInviteAsserted',true,'deliveryProven',false);
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      actor_id,from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,key,'manual_invite_asserted','admin',admin_id,'approved','approved',
      request_hash,now_at,now_at+interval '12 months',result);
    RETURN result;
  END IF;

  IF op='expire' THEN
    IF request.state NOT IN ('pending','approved') OR request.payload_purge_after>now_at
    THEN RAISE EXCEPTION 'request is not due'; END IF;
    old_state:=request.state;
    UPDATE otl.referral_requests SET state='expired',revision=revision+1,terminal_at=now_at
      WHERE team_id=t AND request_id=request.request_id RETURNING * INTO request;
    result:=otl.referral_receipt(request);
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      actor_id,from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
    VALUES(t,request.request_id,key,'expired','retention',admin_id,old_state,'expired',
      request_hash,now_at,now_at+interval '12 months',result);
    RETURN result;
  END IF;
  RAISE EXCEPTION 'invalid referral admin operation';
END $$;

DO $$ BEGIN
  IF to_regprocedure('otl.member_status(text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION otl.member_status(text,text) FROM PUBLIC;
  END IF;
  IF to_regprocedure('otl.issue_invite(text,text,text,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION otl.issue_invite(text,text,text,text,text) FROM PUBLIC;
  END IF;
  IF to_regprocedure('otl.redeem_invite(text,text,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION otl.redeem_invite(text,text,text,text) FROM PUBLIC;
  END IF;
  IF to_regprocedure('otl.check_invite(text,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION otl.check_invite(text,text,text) FROM PUBLIC;
  END IF;
END $$;

REVOKE ALL ON TABLE otl.member_referral_links,otl.referral_admins,otl.referral_requests,
  otl.referral_consents,otl.referral_submission_receipts,
  otl.referral_private_payloads,otl.referral_request_events,otl.referral_decisions,
  otl.referral_manual_invite_assertions,otl.member_referral_attributions,otl.referral_outbox
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin;
REVOKE ALL ON FUNCTION otl.referral_audit_immutable(),otl.referral_receipt(otl.referral_requests),
  otl.referral_link_identity_immutable(),otl.referral_request_identity_immutable(),
  otl.referral_payload_identity_immutable(),otl.referral_runtime_execute(text,jsonb),
  otl.referral_admin_execute(text,jsonb)
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin;
GRANT EXECUTE ON FUNCTION otl.referral_runtime_execute(text,jsonb) TO otl_referral_runtime;
GRANT EXECUTE ON FUNCTION otl.referral_admin_execute(text,jsonb) TO otl_referral_admin;

INSERT INTO otl.schema_migrations(version) VALUES('030-referral-applications');
COMMIT;
