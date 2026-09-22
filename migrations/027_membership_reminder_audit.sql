BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:membership-reminder-audit:027',0));

ALTER TABLE otl.workspace_channels ADD COLUMN membership_observed_at timestamptz;

ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_membership_audit;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_membership_audit(text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION otl.reminder_eligible(t text,c text,u text,kind text,local_now timestamp)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
 SELECT $4 IN ('goal','review') AND EXISTS (
  SELECT 1 FROM otl.community_preferences p
  JOIN otl.workspace_members m USING(team_id,user_id)
  JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
  LEFT JOIN otl.community_days d ON d.team_id=p.team_id AND d.channel_id=p.channel_id
    AND d.user_id=p.user_id AND d.day=local_now::date
  WHERE p.team_id=t AND p.channel_id=c AND p.user_id=u AND p.enabled AND cm.is_current
    AND p.eligible_from<=local_now::date AND NOT coalesce(m.is_bot,false)
    AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false)
    AND extract(isodow FROM local_now)<6 AND local_now::time>='08:00'::time AND local_now::time<'22:00'::time
    AND NOT coalesce(d.resting,false)
    AND (($4='goal' AND local_now::time>=p.goal_time AND coalesce(d.goal,'')='')
      OR ($4='review' AND local_now::time>=p.review_time AND coalesce(d.goal,'')<>''
        AND coalesce(d.reflection,'')=''))
 )
$$;
REVOKE EXECUTE ON FUNCTION otl.reminder_eligible(text,text,text,text,timestamp) FROM PUBLIC;

CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
 local_now timestamp; observed timestamptz; member jsonb; channel_seen timestamptz;
 chosen_batch text; lease text:=p->>'leaseToken'; attempt integer; affected integer;
 retry_seconds integer; error_code text:=p->>'errorCode'; rec otl.community_records;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;

 IF op='reconcile_channel_members' THEN
  IF p->'complete' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p->'members') IS DISTINCT FROM 'array'
    OR coalesce(p->>'observedAt','')='' THEN RAISE EXCEPTION 'complete membership snapshot required'; END IF;
  observed:=(p->>'observedAt')::timestamptz;
  FOR member IN SELECT value FROM jsonb_array_elements(p->'members') LOOP
   IF coalesce(member->>'userId','')!~'^[UW][A-Z0-9]+$'
     OR coalesce(member->>'displayName','')=''
     OR jsonb_typeof(member->'isBot') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(member->'isAppUser') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(member->'deleted') IS DISTINCT FROM 'boolean'
   THEN RAISE EXCEPTION 'invalid channel member'; END IF;
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c)::text,27));
  INSERT INTO otl.workspaces(team_id) VALUES(t) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_channels(team_id,channel_id,membership_observed_at)
    VALUES(t,c,NULL) ON CONFLICT(team_id,channel_id) DO NOTHING;
  SELECT membership_observed_at INTO channel_seen FROM otl.workspace_channels
    WHERE team_id=t AND channel_id=c FOR UPDATE;
  IF channel_seen IS NOT NULL AND observed<=channel_seen THEN RETURN 'false'::jsonb; END IF;
  UPDATE otl.workspace_channels SET membership_observed_at=observed WHERE team_id=t AND channel_id=c;
  FOR member IN SELECT value FROM jsonb_array_elements(p->'members') LOOP
   INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted,directory_synced_at,first_observed_at)
    VALUES(t,member->>'userId',member->>'displayName',(member->>'isBot')::boolean,
      (member->>'isAppUser')::boolean,(member->>'deleted')::boolean,observed,observed)
    ON CONFLICT(team_id,user_id) DO UPDATE SET display_name=excluded.display_name,is_bot=excluded.is_bot,
      is_app_user=excluded.is_app_user,slack_deleted=excluded.slack_deleted,directory_synced_at=excluded.directory_synced_at
    WHERE otl.workspace_members.directory_synced_at IS NULL OR otl.workspace_members.directory_synced_at<excluded.directory_synced_at;
   INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
    VALUES(t,c,member->>'userId',true,observed,observed)
    ON CONFLICT(team_id,channel_id,user_id) DO UPDATE SET is_current=true,last_seen_at=excluded.last_seen_at,
      synced_at=excluded.synced_at WHERE otl.workspace_channel_memberships.synced_at<excluded.synced_at;
  END LOOP;
  UPDATE otl.workspace_channel_memberships cm SET is_current=false,synced_at=observed
   WHERE cm.team_id=t AND cm.channel_id=c AND cm.synced_at<observed
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'members') x WHERE x->>'userId'=cm.user_id);
  UPDATE otl.community_records r SET status='cancelled',reminder_lease_token=NULL,
    reminder_lease_expires_at=NULL,reminder_retry_after=NULL,updated_at=observed
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.status IN ('pending','failed')
    AND NOT EXISTS(SELECT 1 FROM otl.workspace_channel_memberships cm
      WHERE cm.team_id=t AND cm.channel_id=c AND cm.user_id=r.user_id AND cm.is_current);
  RETURN 'true'::jsonb;
 END IF;

 IF op='observe_member_join' THEN
  member:=p->'member'; observed:=(p->>'observedAt')::timestamptz;
  u:=member->>'userId';
  IF u IS DISTINCT FROM member->>'userId' OR u!~'^[UW][A-Z0-9]+$' OR coalesce(member->>'displayName','')=''
    OR member->>'isBot'<>'false' OR member->>'isAppUser'<>'false' OR member->>'deleted'<>'false'
  THEN RAISE EXCEPTION 'verified human join required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u)::text,27));
  INSERT INTO otl.workspaces(team_id) VALUES(t) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_channels(team_id,channel_id,membership_observed_at) VALUES(t,c,NULL)
    ON CONFLICT(team_id,channel_id) DO NOTHING;
  SELECT membership_observed_at INTO channel_seen FROM otl.workspace_channels
    WHERE team_id=t AND channel_id=c FOR UPDATE;
  IF channel_seen IS NOT NULL AND observed<=channel_seen THEN RETURN 'false'::jsonb; END IF;
  UPDATE otl.workspace_channels SET membership_observed_at=observed WHERE team_id=t AND channel_id=c;
  INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted,directory_synced_at,first_observed_at)
    VALUES(t,u,member->>'displayName',false,false,false,observed,observed)
    ON CONFLICT(team_id,user_id) DO UPDATE SET display_name=excluded.display_name,is_bot=false,is_app_user=false,
      slack_deleted=false,directory_synced_at=excluded.directory_synced_at
    WHERE otl.workspace_members.directory_synced_at IS NULL OR otl.workspace_members.directory_synced_at<excluded.directory_synced_at;
  INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
    VALUES(t,c,u,true,observed,observed)
    ON CONFLICT(team_id,channel_id,user_id) DO UPDATE SET is_current=true,last_seen_at=excluded.last_seen_at,
      synced_at=excluded.synced_at WHERE otl.workspace_channel_memberships.synced_at<excluded.synced_at;
  INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source)
    VALUES(t,c,u,EXISTS(SELECT 1 FROM otl.workspaces WHERE team_id=t AND primary_goal_channel_id=c),'default')
    ON CONFLICT DO NOTHING;
  RETURN 'true'::jsonb;
 END IF;

 IF op IN ('reminder_trigger_due','claim_reminder_batch','prune_reminder_batch') THEN
  local_now:=(p->>'now')::timestamptz AT TIME ZONE 'Asia/Seoul';
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,local_now::date)::text,27));
  UPDATE otl.community_records r SET status='cancelled',reminder_lease_token=NULL,
    reminder_lease_expires_at=NULL,reminder_retry_after=NULL,updated_at=(p->>'now')::timestamptz
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder'
    AND (r.status='pending' OR (r.status='failed' AND coalesce(r.reminder_last_error_code,'') NOT IN ('transport_error','history_incomplete')))
    AND (r.body->>'date'<>local_now::date::text OR NOT otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now)
      OR r.reminder_attempts>=3);
 END IF;

 IF op='reminder_trigger_due' THEN
  IF extract(isodow FROM local_now)>=6 OR local_now::time<'08:00'::time OR local_now::time>='22:00'::time
    THEN RETURN 'false'::jsonb; END IF;
  RETURN to_jsonb(EXISTS(SELECT 1 FROM otl.community_preferences pref
    CROSS JOIN (VALUES('goal'),('review')) requested(kind)
    WHERE pref.team_id=t AND pref.channel_id=c
      AND otl.reminder_eligible(t,c,pref.user_id,requested.kind,local_now)
      AND NOT EXISTS(SELECT 1 FROM otl.community_records existing
        WHERE existing.team_id=t AND existing.channel_id=c AND existing.user_id=pref.user_id
          AND existing.kind='reminder' AND existing.body->>'date'=local_now::date::text
          AND existing.body->>'kind'=requested.kind))
    OR EXISTS(SELECT 1 FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder'
      AND r.reminder_attempts<3 AND (r.status='pending' OR
        (r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity')<=(p->>'now')::timestamptz) OR
        (r.status='claimed' AND r.reminder_lease_expires_at<=(p->>'now')::timestamptz))));
 END IF;

 IF op='claim_reminder_batch' THEN
  IF coalesce(lease,'')='' OR coalesce(p->>'workerId','')='' THEN RAISE EXCEPTION 'lease required'; END IF;
  PERFORM otl.community_execute_before_membership_audit('due',p);
  SELECT reminder_batch_key INTO chosen_batch FROM otl.community_records r
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.reminder_attempts<3
    AND r.status IN ('failed','claimed') AND r.reminder_batch_key IS NOT NULL
    AND ((r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity')<=(p->>'now')::timestamptz)
      OR (r.status='claimed' AND r.reminder_lease_expires_at<=(p->>'now')::timestamptz))
   ORDER BY r.updated_at,r.reminder_batch_key LIMIT 1;
  IF chosen_batch IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c
      AND r.kind='reminder' AND r.reminder_batch_key=chosen_batch
      AND r.reminder_last_error_code NOT IN ('transport_error','history_incomplete')) THEN
    UPDATE otl.community_records r SET status='cancelled',reminder_retry_after=NULL,updated_at=(p->>'now')::timestamptz
     WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.reminder_batch_key=chosen_batch
      AND r.status IN ('failed','claimed') AND NOT otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now);
   END IF;
   UPDATE otl.community_records r SET status='claimed',reminder_attempts=reminder_attempts+1,
    reminder_lease_token=lease,reminder_lease_expires_at=(p->>'now')::timestamptz+interval '5 minutes',
    reminder_retry_after=NULL,updated_at=(p->>'now')::timestamptz
    WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.reminder_batch_key=chosen_batch
      AND r.reminder_attempts<3 AND r.status IN ('failed','claimed')
      AND coalesce(r.reminder_retry_after,r.reminder_lease_expires_at,'-infinity')<=(p->>'now')::timestamptz;
  ELSE
   chosen_batch:=lease;
   WITH candidates AS (
    SELECT r.ctid,row_number() OVER(ORDER BY r.body->>'kind',r.user_id) n,
      sum(length(r.user_id)+4) OVER(ORDER BY r.body->>'kind',r.user_id) chars
    FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder'
      AND r.status='pending' AND r.body->>'date'=local_now::date::text
      AND otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now)
   )
   UPDATE otl.community_records r SET status='claimed',reminder_attempts=1,reminder_batch_key=chosen_batch,
    reminder_first_attempt_at=(p->>'now')::timestamptz,reminder_lease_token=lease,
    reminder_lease_expires_at=(p->>'now')::timestamptz+interval '5 minutes',updated_at=(p->>'now')::timestamptz
   FROM candidates x WHERE r.ctid=x.ctid AND x.n<=100 AND x.chars<=2400;
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=0 THEN RETURN 'null'::jsonb; END IF;
  SELECT max(reminder_attempts) INTO attempt FROM otl.community_records WHERE reminder_lease_token=lease;
  RETURN jsonb_build_object('leaseToken',lease,'attempt',attempt,'firstAttemptAt',(
    SELECT min(reminder_first_attempt_at) FROM otl.community_records WHERE reminder_lease_token=lease),'jobs',(
    SELECT jsonb_agg(jsonb_build_object('teamId',r.team_id,'channelId',r.channel_id,'userId',r.user_id,
      'key',r.record_key,'date',r.body->>'date','kind',r.body->>'kind') ORDER BY r.body->>'kind',r.user_id)
    FROM otl.community_records r WHERE r.reminder_lease_token=lease));
 END IF;

 IF op='prune_reminder_batch' THEN
  UPDATE otl.community_records r SET status='cancelled',reminder_lease_token=NULL,
    reminder_lease_expires_at=NULL,updated_at=(p->>'now')::timestamptz
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.status='claimed'
    AND r.reminder_lease_token=lease AND NOT otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now);
  IF NOT EXISTS(SELECT 1 FROM otl.community_records WHERE reminder_lease_token=lease AND status='claimed')
    THEN RETURN 'null'::jsonb; END IF;
  RETURN jsonb_build_object('leaseToken',lease,'attempt',(
    SELECT max(reminder_attempts) FROM otl.community_records WHERE reminder_lease_token=lease),
    'firstAttemptAt',(SELECT min(reminder_first_attempt_at) FROM otl.community_records WHERE reminder_lease_token=lease),
    'jobs',(SELECT jsonb_agg(jsonb_build_object('teamId',r.team_id,'channelId',r.channel_id,'userId',r.user_id,
      'key',r.record_key,'date',r.body->>'date','kind',r.body->>'kind') ORDER BY r.body->>'kind',r.user_id)
      FROM otl.community_records r WHERE r.reminder_lease_token=lease AND r.status='claimed'));
 END IF;

 IF op='claim_common_delivery' THEN
  IF coalesce(u,'')='' OR coalesce(lease,'')='' THEN RAISE EXCEPTION 'common lease required'; END IF;
  SELECT * INTO rec FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.user_id=u
    AND r.kind='dispatch' AND r.status IN ('pending','failed','claimed') AND r.reminder_attempts<3
    AND (r.status='pending' OR (r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity')<=(p->>'now')::timestamptz)
      OR (r.status='claimed' AND r.reminder_lease_expires_at<=(p->>'now')::timestamptz))
    ORDER BY r.updated_at,r.record_key LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.community_records SET status='claimed',reminder_attempts=reminder_attempts+1,
    reminder_first_attempt_at=coalesce(reminder_first_attempt_at,(p->>'now')::timestamptz),
    reminder_lease_token=lease,reminder_lease_expires_at=(p->>'now')::timestamptz+interval '5 minutes',
    reminder_retry_after=NULL,updated_at=(p->>'now')::timestamptz
   WHERE team_id=t AND channel_id=c AND user_id=u AND record_key=rec.record_key;
  RETURN jsonb_build_object('leaseToken',lease,'attempt',rec.reminder_attempts+1,
    'firstAttemptAt',coalesce(rec.reminder_first_attempt_at,(p->>'now')::timestamptz),
    'key',rec.record_key,'text',rec.body->>'text','date',rec.body->>'date','kind',rec.body->>'kind');
 END IF;

 IF op='finish_common_delivery' THEN
  IF coalesce(u,'')='' OR coalesce(lease,'')='' OR p->>'status' NOT IN ('sent','failed')
    THEN RAISE EXCEPTION 'invalid common finish'; END IF;
  IF p->>'status'='sent' THEN
   UPDATE otl.community_records SET status='sent',body=body||jsonb_build_object('messageTs',p->>'messageTs'),
    reminder_lease_token=NULL,reminder_lease_expires_at=NULL,reminder_retry_after=NULL,
    reminder_last_error_code=NULL,updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND kind='dispatch' AND status='claimed' AND reminder_lease_token=lease;
  ELSE
   error_code:=p->>'errorCode';
   IF error_code NOT IN ('rate_limited','transport_error','http_5xx','history_incomplete','terminal_provider_error')
    THEN RAISE EXCEPTION 'invalid common error'; END IF;
   retry_seconds:=least(greatest(coalesce((p->>'retryAfterSeconds')::integer,60),1),3600);
   UPDATE otl.community_records SET status='failed',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=CASE WHEN reminder_attempts<3 AND error_code<>'terminal_provider_error'
      THEN now()+make_interval(secs=>retry_seconds) END,
    reminder_last_error_code=error_code,updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND kind='dispatch' AND status='claimed' AND reminder_lease_token=lease;
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN to_jsonb(affected>0);
 END IF;

 IF op='next_schedule_due' THEN
  RETURN to_jsonb((SELECT min(due_at) FROM (
    SELECT coalesce(reminder_retry_after,reminder_lease_expires_at) due_at FROM otl.community_records
      WHERE team_id=t AND channel_id=c AND kind IN ('reminder','dispatch') AND reminder_attempts<3
       AND status IN ('failed','claimed')
    UNION ALL SELECT (p->>'now')::timestamptz FROM otl.community_records
      WHERE team_id=t AND channel_id=c AND kind IN ('reminder','dispatch') AND status='pending' LIMIT 1
  ) due WHERE due_at IS NOT NULL));
 END IF;

 RETURN otl.community_execute_before_membership_audit(op,p);
END $$;
REVOKE ALL ON FUNCTION otl.community_execute(text,jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('027-membership-reminder-audit');
COMMIT;
