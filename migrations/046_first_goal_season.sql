BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:first-goal-season:046',0));

ALTER FUNCTION otl.community_execute(text,jsonb)
  RENAME TO community_execute_before_first_goal_season;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_first_goal_season(text,jsonb) FROM PUBLIC;

CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  result jsonb;
  t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
  observed timestamptz;
  local_day date;
  source_ts text;
  thread_ts text;
BEGIN
  result:=otl.community_execute_before_first_goal_season(op,p);
  IF NOT (
    (op='observe_member_join' AND result='true'::jsonb)
    OR (op='change' AND p->>'action'='goal'
      AND coalesce((result->>'changed')::boolean,false)
      AND NOT coalesce((result->>'conflict')::boolean,false))
  ) THEN RETURN result; END IF;

  observed:=CASE WHEN op='observe_member_join' THEN (p->>'observedAt')::timestamptz
    ELSE coalesce((p->>'now')::timestamptz,transaction_timestamp()) END;
  local_day:=(observed AT TIME ZONE 'Asia/Seoul')::date;
  IF op='change' AND (p->>'date')::date<>local_day THEN RETURN result; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u)::text,46));
  INSERT INTO otl.member_lifecycles(
    team_id,channel_id,user_id,state,revision,rollout_at,last_transition_at
  )
  SELECT t,c,u,'active',0,observed,observed
  FROM otl.workspace_channel_memberships cm
  JOIN otl.workspace_members wm USING(team_id,user_id)
  WHERE cm.team_id=t AND cm.channel_id=c AND cm.user_id=u AND cm.is_current
    AND NOT coalesce(wm.is_bot,false) AND NOT coalesce(wm.is_app_user,false)
    AND NOT coalesce(wm.slack_deleted,false)
  ON CONFLICT(team_id,user_id) DO NOTHING;

  INSERT INTO otl.grass_seasons(
    team_id,channel_id,user_id,opened_at,opened_on,opened_reason
  )
  SELECT l.team_id,l.channel_id,l.user_id,observed,local_day,'rollout'
  FROM otl.member_lifecycles l
  WHERE l.team_id=t AND l.channel_id=c AND l.user_id=u AND l.state IN('active','grace')
    AND NOT EXISTS(SELECT 1 FROM otl.grass_seasons s
      WHERE s.team_id=l.team_id AND s.user_id=l.user_id AND s.closed_at IS NULL)
  ON CONFLICT DO NOTHING;

  IF op='observe_member_join' THEN
    SELECT coalesce(r.body->>'source',substring(r.record_key FROM 10)),r.body->>'thread'
      INTO source_ts,thread_ts
    FROM otl.community_records r
    WHERE r.team_id=t AND r.channel_id=c AND r.user_id=u AND r.kind='incoming'
      AND r.status='sent' AND r.body->>'date'=local_day::text
    ORDER BY r.updated_at DESC LIMIT 1;
    IF source_ts~'^\d{1,16}\.\d{1,12}$' AND thread_ts~'^\d{1,16}\.\d{1,12}$'
    THEN PERFORM otl.enqueue_member_goal_garden(t,c,u,local_day,source_ts,thread_ts); END IF;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION otl.community_execute(text,jsonb) FROM PUBLIC;

WITH eligible AS (
  SELECT cm.team_id,cm.channel_id,cm.user_id,transaction_timestamp() observed
  FROM otl.workspace_channel_memberships cm
  JOIN otl.workspace_members wm USING(team_id,user_id)
  WHERE cm.is_current AND NOT coalesce(wm.is_bot,false)
    AND NOT coalesce(wm.is_app_user,false) AND NOT coalesce(wm.slack_deleted,false)
), inserted AS (
  INSERT INTO otl.member_lifecycles(
    team_id,channel_id,user_id,state,revision,rollout_at,last_transition_at
  )
  SELECT e.team_id,e.channel_id,e.user_id,'active',0,e.observed,e.observed FROM eligible e
  ON CONFLICT(team_id,user_id) DO NOTHING RETURNING team_id,user_id
)
INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
SELECT l.team_id,l.channel_id,l.user_id,transaction_timestamp(),
  (transaction_timestamp() AT TIME ZONE 'Asia/Seoul')::date,'rollout'
FROM otl.member_lifecycles l
JOIN eligible e USING(team_id,channel_id,user_id)
WHERE l.state IN('active','grace') AND NOT EXISTS(
  SELECT 1 FROM otl.grass_seasons s
  WHERE s.team_id=l.team_id AND s.user_id=l.user_id AND s.closed_at IS NULL
)
ON CONFLICT DO NOTHING;

INSERT INTO otl.schema_migrations(version) VALUES('046-first-goal-season');
COMMIT;
