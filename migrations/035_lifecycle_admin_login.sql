BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:lifecycle-admin-login:035',0));

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_lifecycle_admin_login') THEN
    CREATE ROLE otl_lifecycle_admin_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname='otl_lifecycle_admin_login') THEN
    RAISE EXCEPTION 'unsafe lifecycle admin login role';
  END IF;
END $$;
ALTER ROLE otl_lifecycle_admin_login LOGIN NOCREATEDB NOCREATEROLE INHERIT;
DO $$ DECLARE membership record; BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name
    FROM pg_auth_members am JOIN pg_roles parent ON parent.oid=am.roleid
      JOIN pg_roles member ON member.oid=am.member
    WHERE member.rolname='otl_lifecycle_admin_login' AND parent.rolname<>'otl_lifecycle_admin'
  LOOP
    EXECUTE format('REVOKE %I FROM otl_lifecycle_admin_login',membership.parent_name);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA otl FROM otl_lifecycle_admin_login;
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM otl_lifecycle_admin_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM otl_lifecycle_admin_login;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otl FROM otl_lifecycle_admin_login;
-- PostgreSQL PUBLIC grants otherwise remain callable by every LOGIN role.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA otl FROM PUBLIC;
GRANT otl_lifecycle_admin TO otl_lifecycle_admin_login;

CREATE FUNCTION otl.lifecycle_admin_candidate(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
  l otl.member_lifecycles; evaluations jsonb;
BEGIN
  IF t !~ '^T[A-Z0-9]+$' OR c !~ '^C[A-Z0-9]+$' OR u !~ '^[UW][A-Z0-9]+$'
    THEN RAISE EXCEPTION 'invalid lifecycle candidate scope'; END IF;
  SELECT * INTO l FROM otl.member_lifecycles
    WHERE team_id=t AND channel_id=c AND user_id=u;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('serviceDate',service_date,
    'eligible',eligible,'exclusionReason',exclusion_reason,'signalKind',signal_kind,
    'candidate',candidate,'explanation',explanation) ORDER BY service_date DESC),'[]'::jsonb)
    INTO evaluations FROM (
      SELECT service_date,eligible,exclusion_reason,signal_kind,candidate,explanation
      FROM otl.lifecycle_runtime_evaluations
      WHERE team_id=t AND channel_id=c AND user_id=u
      ORDER BY service_date DESC LIMIT 7
    ) recent;
  RETURN jsonb_build_object('state',l.state,'revision',l.revision,'evaluations',evaluations);
END $$;
REVOKE ALL ON FUNCTION otl.lifecycle_admin_candidate(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION otl.lifecycle_admin_candidate(jsonb) TO otl_lifecycle_admin;

INSERT INTO otl.schema_migrations(version) VALUES('035-lifecycle-admin-login');
COMMIT;
