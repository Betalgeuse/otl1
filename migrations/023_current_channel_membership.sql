BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:current-channel-membership:023',0));

ALTER TABLE otl.workspace_members ADD COLUMN is_app_user boolean;
CREATE TABLE otl.workspace_channel_memberships (
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  is_current boolean NOT NULL,
  last_seen_at timestamptz,
  synced_at timestamptz NOT NULL,
  PRIMARY KEY(team_id,channel_id,user_id),
  FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id)
);
ALTER TABLE otl.community_records
  ADD COLUMN reminder_attempts smallint NOT NULL DEFAULT 0 CHECK(reminder_attempts BETWEEN 0 AND 3),
  ADD COLUMN reminder_first_attempt_at timestamptz,
  ADD COLUMN reminder_batch_key text,
  ADD COLUMN reminder_lease_token text,
  ADD COLUMN reminder_lease_expires_at timestamptz,
  ADD COLUMN reminder_retry_after timestamptz,
  ADD COLUMN reminder_last_error_code text;
ALTER TABLE otl.community_records ADD CONSTRAINT reminder_lease_shape CHECK (
  kind <> 'reminder' OR
  (reminder_attempts=0 OR ((status='claimed') = (reminder_lease_token IS NOT NULL AND reminder_lease_expires_at IS NOT NULL)))
);

CREATE OR REPLACE FUNCTION otl.reminder_eligible(t text,c text,u text,kind text,local_now timestamp)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
 SELECT EXISTS (
 SELECT 1 FROM otl.community_preferences p
 JOIN otl.workspace_members m USING(team_id,user_id)
 JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
 LEFT JOIN otl.community_days d ON d.team_id=p.team_id AND d.channel_id=p.channel_id AND d.user_id=p.user_id AND d.day=local_now::date
 WHERE p.team_id=t AND p.channel_id=c AND p.user_id=u AND p.enabled AND cm.is_current
 AND p.eligible_from<=local_now::date AND NOT coalesce(m.is_bot,false)
 AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false)
 AND extract(isodow FROM local_now)<6 AND local_now::time>='08:00'::time AND local_now::time<'22:00'::time
 AND NOT coalesce(d.resting,false)
 AND ((kind='goal' AND local_now::time>=p.goal_time AND coalesce(d.goal,'')='')
   OR (kind='review' AND local_now::time>=p.review_time AND coalesce(d.goal,'')<>'' AND coalesce(d.reflection,'')=''))
 )
$$;
REVOKE EXECUTE ON FUNCTION otl.reminder_eligible(text,text,text,text,timestamp) FROM PUBLIC;

ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_current_members;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_current_members(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; local_now timestamp;
 observed timestamptz; member jsonb; chosen_batch text; lease text:=p->>'leaseToken';
 attempt integer; affected integer; retry_seconds integer; error_code text:=p->>'errorCode';
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
 IF op='reconcile_channel_members' THEN
  IF p->'complete' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p->'members') IS DISTINCT FROM 'array'
   OR coalesce(p->>'observedAt','')='' THEN RAISE EXCEPTION 'complete membership snapshot required'; END IF;
  observed:=(p->>'observedAt')::timestamptz;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c)::text,23));
  INSERT INTO otl.workspaces(team_id) VALUES(t) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES(t,c) ON CONFLICT DO NOTHING;
  FOR member IN SELECT value FROM jsonb_array_elements(p->'members') LOOP
   IF coalesce(member->>'userId','')='' OR jsonb_typeof(member->'isBot') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(member->'isAppUser') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(member->'deleted') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'invalid channel member'; END IF;
   INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted,directory_synced_at)
    VALUES(t,member->>'userId',(member->>'isBot')::boolean,(member->>'isAppUser')::boolean,
      (member->>'deleted')::boolean,observed)
    ON CONFLICT(team_id,user_id) DO UPDATE SET is_bot=excluded.is_bot,is_app_user=excluded.is_app_user,
      slack_deleted=excluded.slack_deleted,directory_synced_at=excluded.directory_synced_at;
   INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
    VALUES(t,c,member->>'userId',true,observed,observed)
    ON CONFLICT(team_id,channel_id,user_id) DO UPDATE SET is_current=true,last_seen_at=excluded.last_seen_at,synced_at=excluded.synced_at;
  END LOOP;
  INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
   SELECT t,c,known.user_id,false,NULL,observed FROM (
    SELECT user_id FROM otl.community_preferences WHERE team_id=t AND channel_id=c
    UNION SELECT user_id FROM otl.community_days WHERE team_id=t AND channel_id=c
    UNION SELECT user_id FROM otl.community_records WHERE team_id=t AND channel_id=c) known
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'members') x WHERE x->>'userId'=known.user_id)
   ON CONFLICT(team_id,channel_id,user_id) DO UPDATE SET is_current=false,synced_at=excluded.synced_at;
  UPDATE otl.workspace_channel_memberships cm SET is_current=false,synced_at=observed
   WHERE cm.team_id=t AND cm.channel_id=c AND cm.is_current
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'members') x WHERE x->>'userId'=cm.user_id);
  UPDATE otl.community_records r SET status='cancelled',reminder_lease_token=NULL,
   reminder_lease_expires_at=NULL,reminder_retry_after=NULL,updated_at=observed
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.status IN ('pending','failed')
   AND NOT EXISTS(SELECT 1 FROM otl.workspace_channel_memberships cm
     WHERE cm.team_id=r.team_id AND cm.channel_id=r.channel_id AND cm.user_id=r.user_id AND cm.is_current);
  RETURN 'true'::jsonb;
 END IF;
 IF op='reminder_trigger_due' THEN
  local_now:=(p->>'now')::timestamptz AT TIME ZONE 'Asia/Seoul';
  IF extract(isodow FROM local_now)>=6 OR local_now::time<'08:00'::time OR local_now::time>='22:00'::time
   THEN RETURN 'false'::jsonb; END IF;
  RETURN to_jsonb(EXISTS(SELECT 1 FROM otl.community_preferences pref
   LEFT JOIN otl.workspace_channel_memberships cm ON cm.team_id=pref.team_id AND cm.channel_id=pref.channel_id AND cm.user_id=pref.user_id
   LEFT JOIN otl.workspace_members wm ON wm.team_id=pref.team_id AND wm.user_id=pref.user_id
   LEFT JOIN otl.community_days d ON d.team_id=pref.team_id AND d.channel_id=pref.channel_id
    AND d.user_id=pref.user_id AND d.day=local_now::date
   WHERE pref.team_id=t AND pref.channel_id=c AND pref.enabled AND pref.eligible_from<=local_now::date
   AND (cm.user_id IS NULL OR (cm.is_current AND NOT coalesce(wm.is_bot,false)
    AND NOT coalesce(wm.is_app_user,false) AND NOT coalesce(wm.slack_deleted,false)))
   AND NOT coalesce(d.resting,false)
   AND ((local_now::time>=pref.goal_time AND coalesce(d.goal,'')=''
     AND NOT EXISTS(SELECT 1 FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c
      AND r.user_id=pref.user_id AND r.kind='reminder' AND r.body->>'date'=local_now::date::text AND r.body->>'kind'='goal'))
    OR (local_now::time>=pref.review_time AND coalesce(d.goal,'')<>'' AND coalesce(d.reflection,'')=''
     AND NOT EXISTS(SELECT 1 FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c
      AND r.user_id=pref.user_id AND r.kind='reminder' AND r.body->>'date'=local_now::date::text AND r.body->>'kind'='review'))))
   OR EXISTS(SELECT 1 FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c
    AND r.kind='reminder' AND r.reminder_attempts<3 AND
    (r.status='pending' OR (r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity'::timestamptz)<=(p->>'now')::timestamptz)
     OR (r.status='claimed' AND r.reminder_lease_expires_at<=(p->>'now')::timestamptz))));
 END IF;
 IF op='members' THEN
  RETURN (SELECT coalesce(jsonb_agg(cm.user_id ORDER BY cm.user_id),'[]'::jsonb)
   FROM otl.workspace_channel_memberships cm JOIN otl.workspace_members m USING(team_id,user_id)
   WHERE cm.team_id=t AND cm.channel_id=c AND cm.is_current AND NOT coalesce(m.is_bot,false)
   AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false));
 END IF;
 IF op='claim_reminder_batch' THEN
  IF coalesce(lease,'')='' OR coalesce(p->>'workerId','')='' THEN RAISE EXCEPTION 'lease required'; END IF;
  local_now:=(p->>'now')::timestamptz AT TIME ZONE 'Asia/Seoul';
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,local_now::date)::text,23));
  PERFORM otl.community_execute_before_current_members('due',p);
  SELECT reminder_batch_key INTO chosen_batch FROM otl.community_records r
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.reminder_attempts<3
   AND r.status IN ('failed','claimed') AND r.reminder_batch_key IS NOT NULL
   AND ((r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity'::timestamptz)<=(p->>'now')::timestamptz)
     OR (r.status='claimed' AND r.reminder_lease_expires_at<=(p->>'now')::timestamptz))
   ORDER BY r.updated_at,r.reminder_batch_key LIMIT 1;
  IF chosen_batch IS NOT NULL AND EXISTS(SELECT 1 FROM otl.community_records r
    WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.reminder_batch_key=chosen_batch
    AND NOT otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now)) THEN
   UPDATE otl.community_records SET status='cancelled',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=NULL,updated_at=(p->>'now')::timestamptz
    WHERE team_id=t AND channel_id=c AND kind='reminder' AND reminder_batch_key=chosen_batch
    AND status IN ('failed','claimed');
   RETURN 'null'::jsonb;
  END IF;
  IF chosen_batch IS NULL AND NOT EXISTS(SELECT 1 FROM otl.community_records r
    WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.status='pending'
    AND r.body->>'date'=local_now::date::text AND otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now))
   THEN RETURN 'null'::jsonb; END IF;
  chosen_batch:=coalesce(chosen_batch,lease);
  UPDATE otl.community_records r SET status='claimed',reminder_attempts=reminder_attempts+1,
   reminder_batch_key=chosen_batch,reminder_first_attempt_at=coalesce(reminder_first_attempt_at,(p->>'now')::timestamptz),
   reminder_lease_token=lease,
   reminder_lease_expires_at=(p->>'now')::timestamptz+interval '5 minutes',reminder_retry_after=NULL,
   reminder_last_error_code=NULL,updated_at=(p->>'now')::timestamptz
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.reminder_attempts<3
   AND ((r.reminder_batch_key=chosen_batch AND r.status IN ('failed','claimed')
     AND coalesce(r.reminder_retry_after,r.reminder_lease_expires_at,'-infinity'::timestamptz)<=(p->>'now')::timestamptz)
    OR (chosen_batch=lease AND r.status='pending' AND r.body->>'date'=local_now::date::text))
   AND otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now);
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=0 THEN RETURN 'null'::jsonb; END IF;
  SELECT max(reminder_attempts) INTO attempt FROM otl.community_records WHERE reminder_lease_token=lease;
  RETURN jsonb_build_object('leaseToken',lease,'attempt',attempt,'firstAttemptAt',(
   SELECT min(reminder_first_attempt_at) FROM otl.community_records WHERE reminder_lease_token=lease),'jobs',(
   SELECT jsonb_agg(jsonb_build_object('teamId',r.team_id,'channelId',r.channel_id,'userId',r.user_id,
    'key',r.record_key,'date',r.body->>'date','kind',r.body->>'kind') ORDER BY r.body->>'kind',r.user_id)
   FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.reminder_lease_token=lease));
 END IF;
 IF op='finish_reminder_batch' THEN
  IF coalesce(lease,'')='' OR p->>'status' NOT IN ('sent','failed','cancelled') THEN RAISE EXCEPTION 'invalid batch finish'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,lease)::text,23));
  IF p->>'status'='sent' THEN
   UPDATE otl.community_records SET status='sent',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=NULL,reminder_last_error_code=NULL,updated_at=now()
    WHERE team_id=t AND channel_id=c AND kind='reminder' AND status='claimed' AND reminder_lease_token=lease;
  ELSIF p->>'status'='cancelled' THEN
   UPDATE otl.community_records SET status='cancelled',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=NULL,updated_at=now()
    WHERE team_id=t AND channel_id=c AND kind='reminder' AND status='claimed' AND reminder_lease_token=lease;
  ELSE
   IF error_code NOT IN ('rate_limited','transport_error','http_5xx','history_incomplete','terminal_provider_error','batch_too_large')
    THEN RAISE EXCEPTION 'invalid reminder error'; END IF;
   retry_seconds:=least(greatest(coalesce((p->>'retryAfterSeconds')::integer,60),1),3600);
   UPDATE otl.community_records SET status='failed',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=CASE WHEN reminder_attempts<3 AND error_code IN ('rate_limited','transport_error','http_5xx','history_incomplete','batch_too_large')
      THEN now()+make_interval(secs=>retry_seconds) END,
    reminder_last_error_code=error_code,updated_at=now()
    WHERE team_id=t AND channel_id=c AND kind='reminder' AND status='claimed' AND reminder_lease_token=lease;
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN to_jsonb(affected>0);
 END IF;
 RETURN otl.community_execute_before_current_members(op,p);
END $$;
REVOKE ALL ON FUNCTION otl.community_execute(text,jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('023-current-channel-membership');
COMMIT;
