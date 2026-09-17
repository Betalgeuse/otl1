BEGIN;
DO $$
DECLARE s jsonb:=jsonb_build_object('teamId','T-CURRENT','channelId','C-PUBLIC','userId','UADMIN');
 snapshot jsonb; result jsonb; retry jsonb; final_try jsonb; pref_before boolean; history_before text;
BEGIN
 INSERT INTO otl.workspaces(team_id) VALUES('T-CURRENT');
 INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('T-CURRENT','C-PUBLIC');
 INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted)
  VALUES('T-CURRENT','yourminseo',false,false,false);
 INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,preference_source,eligible_from)
  VALUES('T-CURRENT','C-PUBLIC','yourminseo',true,'10:00','18:00','user','2030-01-01');
 snapshot:=s||jsonb_build_object('complete',true,'observedAt','2030-01-07T11:00:00Z','members',jsonb_build_array(
  jsonb_build_object('userId','goal-human','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','review-human','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','optout','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','resting','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','reflected','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','no-goal-review','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','bot','isBot',true,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','app','isBot',false,'isAppUser',true,'deleted',false),
  jsonb_build_object('userId','deleted','isBot',false,'isAppUser',false,'deleted',true),
  jsonb_build_object('userId','amb-one','isBot',false,'isAppUser',false,'deleted',false),
  jsonb_build_object('userId','amb-two','isBot',false,'isAppUser',false,'deleted',false)));
 ASSERT otl.community_execute('reconcile_channel_members',snapshot)='true'::jsonb,'complete snapshot';
 INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,preference_source,eligible_from)
 SELECT 'T-CURRENT','C-PUBLIC',u,true,'10:00','18:00','user','2030-01-01' FROM unnest(ARRAY[
  'goal-human','review-human','resting','reflected','no-goal-review','bot','app','deleted','amb-one','amb-two']) u;
 INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,preference_source,eligible_from)
  VALUES('T-CURRENT','C-PUBLIC','optout',false,'10:00','18:00','user','2030-01-01');
 UPDATE otl.community_preferences SET goal_time='21:00' WHERE team_id='T-CURRENT' AND user_id IN ('no-goal-review','amb-one','amb-two');
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,reflection,resting)
 VALUES('T-CURRENT','C-PUBLIC','review-human','2030-01-07','ship','',false),
 ('T-CURRENT','C-PUBLIC','resting','2030-01-07','ship','',true),
 ('T-CURRENT','C-PUBLIC','reflected','2030-01-07','ship','done',false);
 ASSERT otl.community_execute('reminder_trigger_due',s||jsonb_build_object('now','2030-01-07T11:00:00Z'))='true'::jsonb,'targeted trigger detected before live snapshot';
 result:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:00Z','workerId','qa','leaseToken','lease-one'));
 ASSERT jsonb_array_length(result->'jobs')=2,'only current eligible goal and review humans';
 ASSERT result->'jobs' @> '[{"userId":"goal-human","kind":"goal"}]','goal human included';
 ASSERT result->'jobs' @> '[{"userId":"review-human","kind":"review"}]','review human included';
 ASSERT NOT result::text ~ 'yourminseo|optout|resting|reflected|no-goal-review|bot|app|deleted','excluded classes absent';
 ASSERT otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:01Z','workerId','qa2','leaseToken','lease-two'))='null'::jsonb,'concurrent claim empty';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','lease-one','status','failed','errorCode','rate_limited','retryAfterSeconds',1))='true'::jsonb,'retryable failure';
 retry:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:02Z','workerId','qa','leaseToken','lease-three'));
 ASSERT retry->>'attempt'='2' AND jsonb_array_length(retry->'jobs')=2,'whole batch retry';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','lease-three','status','failed','errorCode','transport_error','retryAfterSeconds',1))='true'::jsonb,'second failure';
 final_try:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:04Z','workerId','qa','leaseToken','lease-four'));
 ASSERT final_try->>'attempt'='3','third attempt';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','lease-four','status','failed','errorCode','http_5xx','retryAfterSeconds',1))='true'::jsonb,'third failure terminal';
 ASSERT otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:00:06Z','workerId','qa','leaseToken','lease-five'))='null'::jsonb,'max three attempts';
 UPDATE otl.community_preferences SET goal_time='10:00' WHERE team_id='T-CURRENT' AND user_id IN ('amb-one','amb-two');
 result:=otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:01:00Z','workerId','qa','leaseToken','amb-first'));
 ASSERT jsonb_array_length(result->'jobs')=2,'ambiguity fixture claimed together';
 ASSERT otl.community_execute('finish_reminder_batch',s||jsonb_build_object('leaseToken','amb-first','status','failed','errorCode','transport_error','retryAfterSeconds',1))='true'::jsonb,'ambiguity fixture retryable';
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,reflection) VALUES('T-CURRENT','C-PUBLIC','amb-two','2030-01-07','now done','already reviewed');
 ASSERT otl.community_execute('claim_reminder_batch',s||jsonb_build_object('now','2030-01-07T11:01:02Z','workerId','qa','leaseToken','amb-retry'))='null'::jsonb,'changed retry batch fails closed';
 ASSERT (SELECT status='cancelled' FROM otl.community_records WHERE team_id='T-CURRENT' AND user_id='amb-one' AND record_key='reminder:2030-01-07:goal'),'eligible subset not reposted after ambiguous acceptance';
 ASSERT otl.community_execute('reminder_trigger_due',s||jsonb_build_object('now','2030-01-07T11:01:03Z'))='false'::jsonb,'terminal records and inactive stale member do not force repeated snapshots';
 SELECT enabled INTO pref_before FROM otl.community_preferences WHERE team_id='T-CURRENT' AND user_id='goal-human';
 SELECT goal INTO history_before FROM otl.community_days WHERE team_id='T-CURRENT' AND user_id='review-human';
 ASSERT otl.community_execute('reconcile_channel_members',s||jsonb_build_object('complete',true,'observedAt','2030-01-07T12:00:00Z','members',jsonb_build_array(
  jsonb_build_object('userId','review-human','isBot',false,'isAppUser',false,'deleted',false))))='true'::jsonb,'second complete snapshot';
 ASSERT NOT (SELECT is_current FROM otl.workspace_channel_memberships WHERE team_id='T-CURRENT' AND channel_id='C-PUBLIC' AND user_id='goal-human'),'absent deactivated';
 ASSERT (SELECT enabled FROM otl.community_preferences WHERE team_id='T-CURRENT' AND user_id='goal-human')=pref_before,'preference preserved';
 ASSERT (SELECT goal FROM otl.community_days WHERE team_id='T-CURRENT' AND user_id='review-human')=history_before,'history preserved';
 BEGIN
  PERFORM otl.community_execute('reconcile_channel_members',s||jsonb_build_object('complete',false,'observedAt','2030-01-07T13:00:00Z','members','[]'::jsonb));
  RAISE EXCEPTION 'partial snapshot accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='partial snapshot accepted' THEN RAISE; END IF;
 END;
 ASSERT (SELECT is_current FROM otl.workspace_channel_memberships WHERE team_id='T-CURRENT' AND channel_id='C-PUBLIC' AND user_id='review-human'),'partial snapshot made no changes';
END $$;
ROLLBACK;
SELECT 'PASS current member reminder SQL: authoritative membership, guarded reconcile, exclusions, whole-batch lease/retry/max3 and preserved history/preferences';
