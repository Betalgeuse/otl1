BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:interest-retention-runtime-grants:041',0));

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_interest_runtime_login') THEN
    CREATE ROLE otl_interest_runtime_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_roles
    WHERE rolname='otl_interest_runtime_login'
      AND (NOT rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN RAISE EXCEPTION 'unsafe interest retention runtime login role'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    WHERE member.rolname='otl_interest_runtime_login'
  ) THEN RAISE EXCEPTION 'interest retention runtime login has role membership'; END IF;
END $$;

GRANT USAGE ON SCHEMA otl TO otl_interest_runtime_login;
GRANT EXECUTE ON FUNCTION otl.interest_runtime_execute(text,jsonb),
  otl.interest_retention_execute(text,jsonb),
  otl.interest_retention_next_due(jsonb) TO otl_interest_runtime_login;

INSERT INTO otl.schema_migrations(version) VALUES('041-interest-retention-runtime-grants');
COMMIT;
