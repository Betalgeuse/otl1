BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:first-registration:010',0));
LOCK TABLE otl.community_days,otl.community_milestones IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO otl.community_milestones(team_id,channel_id,user_id,kind)
 SELECT DISTINCT team_id,channel_id,user_id,'first_registration' FROM otl.community_days WHERE goal<>''
 UNION SELECT DISTINCT team_id,channel_id,user_id,'first_registration' FROM otl.community_events WHERE coalesce(result->'day'->>'goal','')<>''
 ON CONFLICT DO NOTHING;
ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_registration;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_registration(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE r jsonb; n integer:=0;
BEGIN
 r:=otl.community_execute_before_registration(op,p);
 IF op='change' AND p->>'action'='goal' AND NOT coalesce((p->>'preserveOutcome')::boolean,false)
  AND coalesce((r->>'changed')::boolean,false) THEN
  INSERT INTO otl.community_milestones(team_id,channel_id,user_id,kind)
   VALUES(p->>'teamId',p->>'channelId',p->>'userId','first_registration') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
 END IF;
 IF op='change' THEN RETURN r||jsonb_build_object('firstRegistration',n=1); END IF;
 RETURN r;
END $$;
INSERT INTO otl.schema_migrations(version) VALUES('010-first-registration');
COMMIT;
