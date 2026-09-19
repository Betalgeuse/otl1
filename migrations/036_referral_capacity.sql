BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:referral-capacity:036',0));

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_referral_admin_login') THEN
    CREATE ROLE otl_referral_admin_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname='otl_referral_admin_login') THEN
    RAISE EXCEPTION 'unsafe referral admin login role';
  END IF;
END $$;
ALTER ROLE otl_referral_admin_login LOGIN NOCREATEDB NOCREATEROLE INHERIT;
DO $$ DECLARE membership record; BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name FROM pg_auth_members am
    JOIN pg_roles parent ON parent.oid=am.roleid
    JOIN pg_roles member ON member.oid=am.member
    WHERE member.rolname='otl_referral_admin_login' AND parent.rolname<>'otl_referral_admin'
  LOOP
    EXECUTE format('REVOKE %I FROM otl_referral_admin_login',membership.parent_name);
  END LOOP;
END $$;
GRANT otl_referral_admin TO otl_referral_admin_login;
REVOKE ALL ON SCHEMA otl FROM otl_referral_admin_login;
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM otl_referral_admin_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM otl_referral_admin_login;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA otl FROM PUBLIC;

CREATE TABLE otl.referral_capacity_defaults (
  team_id text PRIMARY KEY REFERENCES otl.workspaces(team_id),
  maximum integer NOT NULL DEFAULT 2 CHECK(maximum>=0),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE otl.referral_capacity_members (
  team_id text NOT NULL REFERENCES otl.workspaces(team_id),
  user_id text NOT NULL,
  maximum integer NOT NULL CHECK(maximum>=0),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  PRIMARY KEY(team_id,user_id),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id)
);
CREATE TABLE otl.referral_capacity_events (
  team_id text NOT NULL REFERENCES otl.workspaces(team_id),
  event_key text NOT NULL,
  target_user_id text,
  actor_id text NOT NULL,
  request_hash text NOT NULL,
  old_maximum integer NOT NULL,
  new_maximum integer NOT NULL,
  revision integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(team_id,event_key)
);
CREATE TRIGGER referral_capacity_events_immutable BEFORE UPDATE OR DELETE ON otl.referral_capacity_events
  FOR EACH ROW EXECUTE FUNCTION otl.referral_audit_immutable();

CREATE FUNCTION otl.referral_capacity_status(t text,u text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE max_count integer; used_count integer; joined_count integer; reserved_count integer; rev integer;
BEGIN
  SELECT coalesce(m.maximum,d.maximum,2),coalesce(m.revision,0)
    INTO max_count,rev FROM (SELECT t AS team_id) seed
    LEFT JOIN otl.referral_capacity_defaults d USING(team_id)
    LEFT JOIN otl.referral_capacity_members m ON m.team_id=t AND m.user_id=u;
  SELECT count(DISTINCT introduced_user_id) INTO joined_count
    FROM otl.member_referral_attributions WHERE team_id=t AND referrer_user_id=u;
  SELECT count(*) INTO reserved_count FROM otl.referral_requests
    WHERE team_id=t AND referrer_user_id=u AND state='approved';
  used_count:=joined_count+reserved_count;
  RETURN jsonb_build_object('maximum',max_count,'used',used_count,'joined',joined_count,
    'reserved',reserved_count,'remaining',greatest(max_count-used_count,0),'revision',rev);
END $$;

CREATE FUNCTION otl.referral_capacity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE availability jsonb;
BEGIN
  IF NEW.state='approved' AND OLD.state<>'approved' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(NEW.team_id,NEW.referrer_user_id)::text,36));
    availability:=otl.referral_capacity_status(NEW.team_id,NEW.referrer_user_id);
    IF (availability->>'remaining')::integer<1 THEN RAISE EXCEPTION 'referral capacity unavailable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_capacity_guard BEFORE UPDATE OF state ON otl.referral_requests
  FOR EACH ROW EXECUTE FUNCTION otl.referral_capacity_guard();

-- Preserve the existing validated runtime implementation and wrap only capacity-sensitive entry points.
ALTER FUNCTION otl.referral_runtime_execute(text,jsonb) RENAME TO referral_runtime_uncapped;
REVOKE ALL ON FUNCTION otl.referral_runtime_uncapped(text,jsonb) FROM PUBLIC,otl_referral_runtime,otl_referral_admin;
CREATE FUNCTION otl.referral_runtime_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; u text:=p->>'userId'; digest text:=p->>'tokenDigest';
  owner_id text; available jsonb;
BEGIN
  IF op='resolve' THEN
    SELECT referrer_user_id INTO owner_id FROM otl.member_referral_links
      WHERE team_id=t AND token_digest=digest AND status='active';
    IF owner_id IS NULL THEN RETURN jsonb_build_object('available',false); END IF;
    available:=otl.referral_capacity_status(t,owner_id);
    IF (available->>'remaining')::integer=0 THEN RETURN jsonb_build_object('available',false); END IF;
  ELSIF op='issue' THEN
    available:=otl.referral_capacity_status(t,u);
    IF (available->>'remaining')::integer=0 THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  ELSIF op='submit' THEN
    SELECT referrer_user_id INTO owner_id FROM otl.member_referral_links
      WHERE team_id=t AND token_digest=digest AND status='active';
    IF owner_id IS NOT NULL THEN
      available:=otl.referral_capacity_status(t,owner_id);
      IF (available->>'remaining')::integer=0 THEN RAISE EXCEPTION 'referral unavailable'; END IF;
    END IF;
  END IF;
  IF op='issue' THEN
    RETURN otl.referral_runtime_uncapped(op,p)||jsonb_build_object('remaining',available->'remaining');
  END IF;
  RETURN otl.referral_runtime_uncapped(op,p);
END $$;

-- Allow an operator to cancel an approved but unjoined request; the existing decision path
-- still handles pending requests and every other operation.
ALTER FUNCTION otl.referral_admin_execute(text,jsonb) RENAME TO referral_admin_uncapped;
REVOKE ALL ON FUNCTION otl.referral_admin_uncapped(text,jsonb)
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin;
CREATE FUNCTION otl.referral_admin_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; a text:=p->>'adminId'; key text:=p->>'key';
  r otl.referral_requests; event otl.referral_request_events; result jsonb;
  request_hash text:=md5(p::text); now_at timestamptz;
BEGIN
  IF op<>'decide' OR p->>'decision'<>'declined' THEN
    RETURN otl.referral_admin_uncapped(op,p);
  END IF;
  IF coalesce(t,'')='' OR coalesce(a,'')='' OR NOT EXISTS(
    SELECT 1 FROM otl.referral_admins WHERE team_id=t AND user_id=a)
  THEN RAISE EXCEPTION 'referral admin denied'; END IF;
  IF coalesce(key,'')='' OR coalesce(p->>'requestId','')='' OR coalesce(p->>'now','')=''
  THEN RAISE EXCEPTION 'invalid referral admin request'; END IF;
  SELECT * INTO r FROM otl.referral_requests WHERE team_id=t AND request_id=p->>'requestId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral request unavailable'; END IF;
  IF r.state<>'approved' THEN RETURN otl.referral_admin_uncapped(op,p); END IF;
  SELECT * INTO event FROM otl.referral_request_events
    WHERE team_id=t AND request_id=r.request_id AND event_key=key;
  IF FOUND THEN
    IF event.request_hash<>request_hash THEN RAISE EXCEPTION 'referral idempotency collision'; END IF;
    RETURN event.result;
  END IF;
  IF coalesce(p->>'expectedRevision','') !~ '^[0-9]+$' OR
    r.revision<>(p->>'expectedRevision')::integer
  THEN RAISE EXCEPTION 'stale referral revision'; END IF;
  now_at:=(p->>'now')::timestamptz;
  UPDATE otl.referral_requests SET state='declined',revision=revision+1,terminal_at=now_at,
    payload_purge_after=now_at+interval '24 hours'
    WHERE team_id=t AND request_id=r.request_id RETURNING * INTO r;
  INSERT INTO otl.referral_decisions(team_id,request_id,decision_code,decided_by,decided_at,event_key)
    VALUES(t,r.request_id,'declined',a,now_at,key);
  result:=otl.referral_receipt(r);
  INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
    actor_id,from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
  VALUES(t,r.request_id,key,'declined','admin',a,'approved','declined',request_hash,now_at,
    now_at+interval '12 months',result);
  UPDATE otl.referral_outbox SET status='cancelled' WHERE team_id=t AND request_id=r.request_id
    AND status='pending';
  INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
    VALUES(t,r.request_id,'decision:'||key,'admin_decision',now_at);
  RETURN result;
END $$;

CREATE FUNCTION otl.referral_capacity_admin_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; a text:=p->>'adminId'; u text:=p->>'userId';
  key text:=p->>'key'; expected integer; max_count integer; revision_count integer;
  old_count integer; request_hash text:=md5((p-'expectedRevision')::text); prior otl.referral_capacity_events;
  result jsonb; now_at timestamptz;
BEGIN
  IF t !~ '^T[A-Z0-9]+$' OR a !~ '^[UW][A-Z0-9]+$' OR
    NOT EXISTS(SELECT 1 FROM otl.referral_admins WHERE team_id=t AND user_id=a)
  THEN RAISE EXCEPTION 'referral admin denied'; END IF;
  IF op NOT IN ('status','status_default','set_default','set_member') THEN RAISE EXCEPTION 'invalid capacity operation'; END IF;
  IF op='status_default' THEN
    SELECT maximum,revision INTO max_count,revision_count FROM otl.referral_capacity_defaults WHERE team_id=t;
    RETURN jsonb_build_object('maximum',coalesce(max_count,2),'revision',coalesce(revision_count,0));
  END IF;
  IF op='status' THEN
    IF u !~ '^[UW][A-Z0-9]+$' THEN RAISE EXCEPTION 'invalid capacity target'; END IF;
    RETURN otl.referral_capacity_status(t,u);
  END IF;
  IF coalesce(key,'')='' OR coalesce(p->>'expectedRevision','') !~ '^[0-9]+$' OR
    coalesce(p->>'maximum','') !~ '^[0-9]+$' OR coalesce(p->>'now','')=''
  THEN RAISE EXCEPTION 'invalid capacity update'; END IF;
  expected:=(p->>'expectedRevision')::integer;
  max_count:=(p->>'maximum')::integer;
  now_at:=(p->>'now')::timestamptz;
  IF op='set_member' AND (u !~ '^[UW][A-Z0-9]+$' OR NOT EXISTS(
    SELECT 1 FROM otl.workspace_members WHERE team_id=t AND user_id=u AND NOT coalesce(is_bot,false)
      AND NOT coalesce(is_app_user,false) AND NOT coalesce(slack_deleted,false)))
  THEN RAISE EXCEPTION 'referral member unavailable'; END IF;
  IF op='set_default' THEN u:=NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,u)::text,36));
  SELECT * INTO prior FROM otl.referral_capacity_events WHERE team_id=t AND event_key=key;
  IF FOUND THEN
    IF prior.request_hash<>request_hash THEN RAISE EXCEPTION 'capacity idempotency collision'; END IF;
    RETURN prior.result;
  END IF;
  IF op='set_default' THEN
    INSERT INTO otl.referral_capacity_defaults(team_id) VALUES(t) ON CONFLICT DO NOTHING;
    SELECT maximum,revision INTO old_count,revision_count FROM otl.referral_capacity_defaults
      WHERE team_id=t FOR UPDATE;
    IF revision_count<>expected THEN RAISE EXCEPTION 'stale capacity revision'; END IF;
    UPDATE otl.referral_capacity_defaults SET maximum=max_count,revision=revision+1 WHERE team_id=t;
    result:=jsonb_build_object('maximum',max_count,'revision',expected+1);
  ELSE
    SELECT maximum,revision INTO old_count,revision_count FROM otl.referral_capacity_members
      WHERE team_id=t AND user_id=u FOR UPDATE;
    IF NOT FOUND THEN
      old_count:=(SELECT coalesce(maximum,2) FROM otl.referral_capacity_defaults WHERE team_id=t);
      old_count:=coalesce(old_count,2);
      revision_count:=0;
    END IF;
    IF revision_count<>expected THEN RAISE EXCEPTION 'stale capacity revision'; END IF;
    INSERT INTO otl.referral_capacity_members(team_id,user_id,maximum,revision)
      VALUES(t,u,max_count,expected+1)
      ON CONFLICT(team_id,user_id) DO UPDATE SET maximum=excluded.maximum,revision=excluded.revision;
    result:=otl.referral_capacity_status(t,u);
  END IF;
  INSERT INTO otl.referral_capacity_events(team_id,event_key,target_user_id,actor_id,request_hash,
    old_maximum,new_maximum,revision,occurred_at,result)
  VALUES(t,key,u,a,request_hash,old_count,max_count,expected+1,now_at,result);
  RETURN result;
END $$;

REVOKE ALL ON TABLE otl.referral_capacity_defaults,otl.referral_capacity_members,otl.referral_capacity_events
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin,otl_referral_admin_login;
REVOKE ALL ON FUNCTION otl.referral_capacity_status(text,text),otl.referral_capacity_guard(),
  otl.referral_runtime_execute(text,jsonb),otl.referral_admin_execute(text,jsonb),
  otl.referral_capacity_admin_execute(text,jsonb)
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin,otl_referral_admin_login;
GRANT EXECUTE ON FUNCTION otl.referral_runtime_execute(text,jsonb) TO otl_referral_runtime;
GRANT EXECUTE ON FUNCTION otl.referral_admin_execute(text,jsonb) TO otl_referral_admin;
GRANT EXECUTE ON FUNCTION otl.referral_capacity_admin_execute(text,jsonb) TO otl_referral_admin;
INSERT INTO otl.schema_migrations(version) VALUES('036-referral-capacity');
COMMIT;
