BEGIN;
DO $$
DECLARE s jsonb:=jsonb_build_object('teamId','T-CURRENT','channelId','C-PUBLIC','userId','UADMIN');
 snapshot jsonb; result jsonb; retry jsonb; final_try jsonb; pref_before boolean; history_before text;
BEGIN
 INSERT INTO otl.workspaces(team_id) VALUES('T-CURRENT');
 INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('T-CURRENT','C-PUBLIC');
 INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted)
  VALUES('T-CURRENT','UYOURMINSEO',false,false,false);
 INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,preference_source,eligible_from)
  VALUES('T-CURRENT','C-PUBLIC','UYOURMINSEO',true,'10:00','18:00','user','2030-01-01');
 snapshot:=s||jsonb_build_object('complete',true,'observedAt','2030-01-07T11:00:00Z','members',jsonb_build_array(
  jsonb_build_object('userId','UGOAL','displayName','QA UGOAL','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UREVIEW','displayName','QA UREVIEW','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UOPTOUT','displayName','QA UOPTOUT','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UREST','displayName','QA UREST','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UREFLECT','displayName','QA UREFLECT','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UNOGOAL','displayName','QA UNOGOAL','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UBOTFIX','displayName','QA UBOTFIX','isBot',true,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UAPPFIX','displayName','QA UAPPFIX','isBot',false,'isAppUser',true,'deleted',false),
  jsonb_build_object('userId','UDELETE','displayName','QA UDELETE','isBot',false,'isAppUser',false,'deleted',true),
  jsonb_build_object('userId','UAMBONE','displayName','QA UAMBONE','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','UAMBTWO','displayName','QA UAMBTWO','isBot',false,'isAppUser',false,'deleted',false)));
 ASSERT otl.community_execute('reconcile_channel_members',snapshot)='true'::jsonb,'complete snapshot';
 INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
 SELECT cm.team_id,cm.channel_id,cm.user_id,'active','2030-01-07T11:00:00Z','2030-01-07T11:00:00Z'
 FROM otl.workspace_channel_memberships cm JOIN otl.workspace_members m USING(team_id,user_id)
 WHERE cm.team_id='T-CURRENT' AND cm.channel_id='C-PUBLIC' AND cm.is_current
   AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false);
 INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
 SELECT team_id,channel_id,user_id,'2030-01-07T11:00:00Z','2030-01-07','rollout'
 FROM otl.member_lifecycles WHERE team_id='T-CURRENT';
 INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,preference_source,eligible_from)
 SELECT 'T-CURRENT','C-PUBLIC',u,true,'10:00','18:00','user','2030-01-01' FROM unnest(ARRAY[
  'UGOAL','UREVIEW','UREST','UREFLECT','UNOGOAL','UBOTFIX','UAPPFIX','UDELETE','UAMBONE','UAMBTWO']) u;
 INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,preference_source,eligible_from)
  VALUES('T-CURRENT','C-PUBLIC','UOPTOUT',false,'10:00','18:00','user','2030-01-01');
 UPDATE otl.community_preferences SET goal_time='21:00' WHERE team_id='T-CURRENT' AND user_id IN ('UNOGOAL','UAMBONE','UAMBTWO');
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,reflection,resting)
 VALUES('T-CURRENT','C-PUBLIC','UREVIEW','2030-01-07','ship','',false),
 ('T-CURRENT','C-PUBLIC','UREST','2030-01-07','ship','',true),
 ('T-CURRENT','C-PUBLIC','UREFLECT','2030-01-07','ship','done',false);
 ASSERT otl.community_execute('reminder_trigger_due',s||jsonb_build_object('now','2030-01-07T11:00:00Z'))='true'::jsonb,'targeted trigger detected before live snapshot';
 result:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:00Z','workerId','qa','leaseToken','lease-one'));
 ASSERT jsonb_array_length(result->'jobs')=2,'only current eligible goal and review humans';
 ASSERT result->'jobs' @> '[{"userId":"UGOAL","kind":"goal"}]','goal human included';
 ASSERT result->'jobs' @> '[{"userId":"UREVIEW","kind":"review"}]','review human included';
 ASSERT NOT result::text ~ 'UYOURMINSEO|UOPTOUT|UREST|UREFLECT|UNOGOAL|UBOTFIX|UAPPFIX|UDELETE','excluded classes absent';
 ASSERT otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:01Z','workerId','qa2','leaseToken','lease-two'))='null'::jsonb,'concurrent claim empty';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','lease-one','status','failed','errorCode','rate_limited','retryAfterSeconds',1))='true'::jsonb,'retryable failure';
 retry:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:02Z','workerId','qa','leaseToken','lease-three'));
 ASSERT retry->>'attempt'='2' AND jsonb_array_length(retry->'jobs')=2,'whole batch retry';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','lease-three','status','failed','errorCode','transport_error','retryAfterSeconds',1))='true'::jsonb,'second failure';
 final_try:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:04Z','workerId','qa','leaseToken','lease-four'));
 ASSERT final_try->>'attempt'='3','third attempt';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','lease-four','status','failed','errorCode','http_5xx','retryAfterSeconds',1))='true'::jsonb,'third failure terminal';
 ASSERT otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:06Z','workerId','qa','leaseToken','lease-five'))='null'::jsonb,'max three attempts';
 UPDATE otl.community_preferences SET goal_time='10:00' WHERE team_id='T-CURRENT' AND user_id IN ('UAMBONE','UAMBTWO');
 result:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:01:00Z','workerId','qa','leaseToken','amb-first'));
 ASSERT jsonb_array_length(result->'jobs')=2,'ambiguity fixture claimed together';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','amb-first','status','failed','errorCode','transport_error','retryAfterSeconds',1))='true'::jsonb,'ambiguity fixture retryable';
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,reflection) VALUES('T-CURRENT','C-PUBLIC','UAMBTWO','2030-01-07','now done','already reviewed');
 retry:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:01:02Z','workerId','qa','leaseToken','amb-retry'));
 ASSERT jsonb_array_length(retry->'jobs')=2,'ambiguous retry preserves the original payload for history reconciliation';
 retry:=otl.community_execute('prune_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:01:02Z','leaseToken','amb-retry'));
 ASSERT jsonb_array_length(retry->'jobs')=1 AND retry->'jobs' @> '[{"userId":"UAMBONE"}]','history miss prunes only the newly ineligible peer';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','amb-retry','status','sent'))='true'::jsonb,'eligible peer finishes after prune';
 ASSERT (SELECT status='cancelled' FROM otl.community_records WHERE team_id='T-CURRENT' AND user_id='UAMBTWO' AND record_key='reminder:2030-01-07:goal'),'newly ineligible peer cancelled alone';
 ASSERT otl.community_execute('reminder_trigger_due',s||jsonb_build_object('now','2030-01-07T11:01:03Z'))='false'::jsonb,'terminal records and inactive stale member do not force repeated snapshots';
 SELECT enabled INTO pref_before FROM otl.community_preferences WHERE team_id='T-CURRENT' AND user_id='UGOAL';
 SELECT goal INTO history_before FROM otl.community_days WHERE team_id='T-CURRENT' AND user_id='UREVIEW';
 ASSERT otl.community_execute('reconcile_channel_members',s||jsonb_build_object('complete',true,'observedAt','2030-01-07T12:00:00Z','members',jsonb_build_array(
  jsonb_build_object('userId','UREVIEW','displayName','QA UREVIEW','isBot',false,'isAppUser',false,'deleted',false))))='true'::jsonb,'second complete snapshot';
 ASSERT NOT (SELECT is_current FROM otl.workspace_channel_memberships WHERE team_id='T-CURRENT' AND channel_id='C-PUBLIC' AND user_id='UGOAL'),'absent deactivated';
 ASSERT (SELECT enabled FROM otl.community_preferences WHERE team_id='T-CURRENT' AND user_id='UGOAL')=pref_before,'preference preserved';
 ASSERT (SELECT goal FROM otl.community_days WHERE team_id='T-CURRENT' AND user_id='UREVIEW')=history_before,'history preserved';
 BEGIN
  PERFORM otl.community_execute('reconcile_channel_members',s||jsonb_build_object('complete',false,'observedAt','2030-01-07T13:00:00Z','members','[]'::jsonb));
  RAISE EXCEPTION 'partial snapshot accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='partial snapshot accepted' THEN RAISE; END IF;
 END;
 ASSERT (SELECT is_current FROM otl.workspace_channel_memberships WHERE team_id='T-CURRENT' AND channel_id='C-PUBLIC' AND user_id='UREVIEW'),'partial snapshot made no changes';
END $$;
ROLLBACK;
SELECT 'PASS current member reminder SQL: authoritative membership, guarded reconcile, exclusions, bounded lease/retry/max3 and ambiguity-before-prune and preserved history/preferences';
