BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:interest-retention-due:038',0));

CREATE FUNCTION otl.interest_retention_next_due(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; due_at timestamptz;
BEGIN
  IF coalesce(t,'')='' THEN RAISE EXCEPTION 'interest retention scope required'; END IF;
  SELECT min(due.due_at) INTO due_at FROM (
    SELECT payload_purge_after AS due_at FROM otl.interest_requests
      WHERE team_id=t AND state IN ('pending_introduction','introduction_verified')
    UNION ALL
    SELECT coalesce(pp.purge_retry_at,ir.payload_purge_after) FROM otl.interest_private_payloads pp
      JOIN otl.interest_requests ir USING(team_id,interest_id)
      WHERE pp.team_id=t AND pp.purge_status IN ('pending','failed','claimed')
        AND pp.purge_attempts<5
    UNION ALL
    SELECT ir.audit_purge_after FROM otl.interest_requests ir
      JOIN otl.interest_private_payloads pp USING(team_id,interest_id)
      WHERE ir.team_id=t AND ir.state IN ('attached','withdrawn','declined','expired')
        AND pp.purge_status='purged'
    UNION ALL
    SELECT expires_at FROM otl.interest_service_nonces WHERE team_id=t
    UNION ALL
    SELECT recorded_at+interval '12 months' FROM otl.interest_submission_receipts
      WHERE team_id=t AND interest_id IS NULL
  ) due;
  RETURN jsonb_build_object('nextDue',due_at);
END $$;

REVOKE ALL ON FUNCTION otl.interest_retention_next_due(jsonb)
  FROM PUBLIC,otl_referral_runtime,otl_referral_admin,otl_interest_member;
GRANT EXECUTE ON FUNCTION otl.interest_retention_next_due(jsonb) TO otl_referral_runtime;
INSERT INTO otl.schema_migrations(version) VALUES('038-interest-retention-due');
COMMIT;
