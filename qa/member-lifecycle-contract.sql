\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.lifecycle_call(operation text,payload jsonb) RETURNS jsonb
LANGUAGE sql AS $$ SELECT otl.lifecycle_execute(operation,payload) $$;
CREATE FUNCTION pg_temp.complete_snapshot(observed timestamptz) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT otl.community_execute('reconcile_channel_members',jsonb_build_object(
    'teamId','TLIFE','channelId','CLIFE','userId','UACTIVE','observedAt',observed,'complete',true,
    'members',jsonb_build_array(
      jsonb_build_object('userId','UACTIVE','displayName','Active','isBot',false,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UCONCURRENT','displayName','Concurrent','isBot',false,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UGOAL','displayName','Goal','isBot',false,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UOUTCOME','displayName','Outcome','isBot',false,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UREFLECTION','displayName','Reflection','isBot',false,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UREST','displayName','Rest','isBot',false,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UBOT','displayName','Bot','isBot',true,'isAppUser',false,'deleted',false),
      jsonb_build_object('userId','UDELETED','displayName','Deleted','isBot',false,'isAppUser',false,'deleted',true),
      jsonb_build_object('userId','UJOINONLY','displayName','Join Only','isBot',false,'isAppUser',false,'deleted',false)
    )
  ))
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM otl.member_lifecycles WHERE team_id='TLIFE') <> 6 THEN
    RAISE EXCEPTION 'rollout must seed exactly current non-deleted humans';
  END IF;
  IF EXISTS(SELECT 1 FROM otl.member_lifecycles WHERE state<>'active' OR revision<>0) THEN
    RAISE EXCEPTION 'rollout must seed active without retroactive candidates';
  END IF;
  IF (SELECT count(*) FROM otl.grass_seasons WHERE team_id='TLIFE' AND closed_at IS NULL) <> 6 THEN
    RAISE EXCEPTION 'rollout must seed one open season per human';
  END IF;
  IF (SELECT count(*) FROM otl.community_days WHERE team_id='TLIFE') <> 1 OR
     (SELECT count(*) FROM otl.community_events WHERE team_id='TLIFE') <> 1 THEN
    RAISE EXCEPTION 'rollout changed preserved history';
  END IF;
END $$;

DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.lifecycle_call('get','{"teamId":"OTHER","channelId":"CLIFE","userId":"UACTIVE"}');
    RAISE EXCEPTION 'cross-team scope was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='cross-team scope was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('get','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UMISSING"}');
    RAISE EXCEPTION 'unknown user was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='unknown user was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('close_day','{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-09-20","now":"2026-09-20T14:59:59Z"}');
    RAISE EXCEPTION 'open KST day was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='open KST day was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('close_day','{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-02-30","now":"2026-03-01T15:00:00Z"}');
    RAISE EXCEPTION 'malformed date was accepted';
  EXCEPTION WHEN datetime_field_overflow THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('close_day','{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-09-20"}');
    RAISE EXCEPTION 'missing clock was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='missing clock was accepted' THEN RAISE; END IF;
  END;
END $$;

SELECT pg_temp.lifecycle_call('close_day',
  '{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-09-20","now":"2026-09-20T15:00:00Z"}');
SELECT pg_temp.complete_snapshot('2026-09-21T09:00:00Z');
DO $$ BEGIN
  IF pg_temp.complete_snapshot('2026-09-20T09:00:00Z')<>'false'::jsonb OR
    (SELECT complete_membership_observed_at FROM otl.workspace_channels
      WHERE team_id='TLIFE' AND channel_id='CLIFE')<>'2026-09-21T09:00:00Z'
  THEN RAISE EXCEPTION 'stale complete snapshot changed evidence'; END IF;
END $$;
SELECT pg_temp.lifecycle_call('close_day',
  '{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-09-21","now":"2026-09-21T15:00:00Z"}');

INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status,updated_at)
VALUES('TLIFE','CLIFE','UACTIVE','common:2026-09-22:goal','dispatch',
  '{"date":"2026-09-22","kind":"goal"}','sent','2026-09-22T10:00:00Z');
SELECT otl.community_execute('observe_member_join','{
  "teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE",
  "observedAt":"2026-09-22T09:00:00Z",
  "member":{"userId":"UJOINONLY","displayName":"Join Only","isBot":false,"isAppUser":false,"deleted":false}
}');
DO $$ BEGIN
  IF (SELECT membership_observed_at FROM otl.workspace_channels
      WHERE team_id='TLIFE' AND channel_id='CLIFE')<>'2026-09-22T09:00:00Z' OR
    (SELECT complete_membership_observed_at FROM otl.workspace_channels
      WHERE team_id='TLIFE' AND channel_id='CLIFE')<>'2026-09-21T09:00:00Z'
  THEN RAISE EXCEPTION 'join observation changed complete snapshot evidence'; END IF;
END $$;
SELECT pg_temp.lifecycle_call('close_day',
  '{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-09-22","now":"2026-09-22T15:00:00Z"}');

DO $$
DECLARE day date;
BEGIN
  FOREACH day IN ARRAY ARRAY['2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01']::date[] LOOP
    PERFORM pg_temp.complete_snapshot((day::timestamp+'18 hours') AT TIME ZONE 'Asia/Seoul');
    INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status,updated_at)
    VALUES('TLIFE','CLIFE','UACTIVE','common:'||day||':goal','dispatch',
      jsonb_build_object('date',day,'kind','goal'),'sent',day::timestamp AT TIME ZONE 'Asia/Seoul');
    PERFORM pg_temp.lifecycle_call('close_day',jsonb_build_object(
      'teamId','TLIFE','channelId','CLIFE','date',day,
      'now',((day+1)::timestamp AT TIME ZONE 'Asia/Seoul')));
  END LOOP;
END $$;

DO $$
BEGIN
  IF (SELECT exclusion_reason FROM otl.lifecycle_service_days WHERE service_date='2026-09-20')<>'weekend'
    OR (SELECT exclusion_reason FROM otl.lifecycle_service_days WHERE service_date='2026-09-21')<>'goal_prompt_missing'
    OR (SELECT exclusion_reason FROM otl.lifecycle_service_days WHERE service_date='2026-09-22')<>'snapshot_missing'
  THEN RAISE EXCEPTION 'service-day evidence explanations are wrong'; END IF;
  IF (SELECT count(*) FROM otl.member_lifecycles WHERE team_id='TLIFE' AND state='grace' AND revision=1)<>6
  THEN RAISE EXCEPTION 'seven eligible no-signal weekdays did not open grace'; END IF;
  IF EXISTS(SELECT 1 FROM otl.member_lifecycles WHERE team_id='TLIFE' AND grace_deadline<>'2026-10-09')
  THEN RAISE EXCEPTION 'grace is not seven calendar days'; END IF;
  IF (SELECT count(*) FROM otl.member_lifecycle_events WHERE event_type='grace_started')<>6
  THEN RAISE EXCEPTION 'grace event count mismatch'; END IF;
END $$;

SELECT pg_temp.lifecycle_call('close_day',
  '{"teamId":"TLIFE","channelId":"CLIFE","date":"2026-10-01","now":"2026-10-01T15:00:00Z"}');
DO $$ BEGIN
  IF (SELECT count(*) FROM otl.lifecycle_service_days WHERE service_date='2026-10-01')<>1
    OR (SELECT count(*) FROM otl.member_lifecycle_events WHERE event_type='grace_started')<>6
  THEN RAISE EXCEPTION 'service-day replay was not idempotent'; END IF;
END $$;

INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,reflection,resting)
VALUES
 ('TLIFE','CLIFE','UGOAL','2026-10-02','new goal','pending','',false),
 ('TLIFE','CLIFE','UOUTCOME','2026-10-02','existing goal','complete','',false),
 ('TLIFE','CLIFE','UREFLECTION','2026-10-02','existing goal','pending','reflection',false),
 ('TLIFE','CLIFE','UREST','2026-10-02','','pending','',true);
SELECT pg_temp.lifecycle_call('signal',jsonb_build_object('teamId','TLIFE','channelId','CLIFE',
  'userId','UGOAL','date','2026-10-02','signal','goal','now','2026-10-02T01:00:00Z','expectedRevision',1,'key','goal-signal'));
SELECT pg_temp.lifecycle_call('signal',jsonb_build_object('teamId','TLIFE','channelId','CLIFE',
  'userId','UOUTCOME','date','2026-10-02','signal','outcome','now','2026-10-02T01:00:01Z','expectedRevision',1,'key','outcome-signal'));
SELECT pg_temp.lifecycle_call('signal',jsonb_build_object('teamId','TLIFE','channelId','CLIFE',
  'userId','UREFLECTION','date','2026-10-02','signal','reflection','now','2026-10-02T01:00:02Z','expectedRevision',1,'key','reflection-signal'));
SELECT pg_temp.lifecycle_call('signal',jsonb_build_object('teamId','TLIFE','channelId','CLIFE',
  'userId','UREST','date','2026-10-02','signal','rest','now','2026-10-02T01:00:03Z','expectedRevision',1,'key','rest-signal'));
DO $$ BEGIN
  IF (SELECT count(*) FROM otl.member_lifecycles WHERE user_id IN ('UGOAL','UOUTCOME','UREFLECTION','UREST')
      AND state='active' AND revision=2)<>4
  THEN RAISE EXCEPTION 'grace signal matrix failed'; END IF;
  IF (SELECT count(*) FROM otl.grass_seasons WHERE user_id IN ('UGOAL','UOUTCOME','UREFLECTION','UREST'))<>4
  THEN RAISE EXCEPTION 'grace signal replaced a preserved season'; END IF;
END $$;

SELECT pg_temp.lifecycle_call('extend',
  '{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","now":"2026-10-08T10:00:00Z","expectedRevision":1,"key":"extension"}');
SELECT pg_temp.lifecycle_call('extend',
  '{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","now":"2026-10-08T10:00:00Z","expectedRevision":1,"key":"extension"}');
DO $$ BEGIN
  IF (SELECT grace_deadline FROM otl.member_lifecycles WHERE user_id='UACTIVE')<>'2026-10-16'
  THEN RAISE EXCEPTION 'extension did not add seven calendar days'; END IF;
  BEGIN
    PERFORM pg_temp.lifecycle_call('expire','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","now":"2026-10-14T10:00:00Z","expectedRevision":2,"key":"early-expiry"}');
    RAISE EXCEPTION 'early expiry was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='early expiry was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('extend','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","now":"2026-10-08T10:00:01Z","expectedRevision":2,"key":"extension-2"}');
    RAISE EXCEPTION 'second extension was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='second extension was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('extend','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","now":"2026-10-08T10:00:01Z","expectedRevision":1,"key":"extension"}');
    RAISE EXCEPTION 'idempotency collision was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='idempotency collision was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('extend','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UCONCURRENT","now":"2026-09-30T00:00:00Z","expectedRevision":1,"key":"stale-clock"}');
    RAISE EXCEPTION 'stale clock was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='stale clock was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.lifecycle_call('extend','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UCONCURRENT","now":"2026-10-08T10:00:00Z","expectedRevision":0,"key":"stale-revision"}');
    RAISE EXCEPTION 'stale revision was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='stale revision was accepted' THEN RAISE; END IF;
  END;
END $$;

DO $$
DECLARE before_events bigint; before_revision integer;
BEGIN
  SELECT count(*) INTO before_events FROM otl.member_lifecycle_events WHERE user_id='UCONCURRENT';
  SELECT revision INTO before_revision FROM otl.member_lifecycles WHERE user_id='UCONCURRENT';
  BEGIN
    PERFORM pg_temp.lifecycle_call('extend','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UCONCURRENT","now":"2026-10-08T11:00:00Z","expectedRevision":1,"key":"rolled-back"}');
    RAISE EXCEPTION 'force transaction rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'force transaction rollback' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM otl.member_lifecycle_events WHERE user_id='UCONCURRENT')<>before_events
    OR (SELECT revision FROM otl.member_lifecycles WHERE user_id='UCONCURRENT')<>before_revision
  THEN RAISE EXCEPTION 'failed transaction left partial lifecycle rows'; END IF;
END $$;

SELECT pg_temp.lifecycle_call('expire',
  '{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","now":"2026-10-15T15:00:01Z","expectedRevision":2,"key":"expiry"}');
DO $$ BEGIN
  IF (SELECT state FROM otl.member_lifecycles WHERE user_id='UACTIVE')<>'dormant'
    OR (SELECT count(*) FROM otl.grass_seasons WHERE user_id='UACTIVE' AND closed_reason='grace_expired')<>1
  THEN RAISE EXCEPTION 'expiry did not close the season'; END IF;
END $$;

INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,reflection,resting)
VALUES('TLIFE','CLIFE','UACTIVE','2026-10-17','','pending','',true);
DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.lifecycle_call('signal','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","date":"2026-10-17","signal":"rest","now":"2026-10-17T01:00:00Z","expectedRevision":3,"key":"dormant-rest"}');
    RAISE EXCEPTION 'dormant rest was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='dormant rest was accepted' THEN RAISE; END IF;
  END;
END $$;
UPDATE otl.community_days SET goal='backdated goal',resting=false WHERE team_id='TLIFE' AND user_id='UACTIVE' AND day='2026-10-17';
SELECT pg_temp.lifecycle_call('signal','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","date":"2026-10-17","signal":"goal","now":"2026-10-18T01:00:00Z","expectedRevision":3,"key":"backdated-goal"}');
DO $$ BEGIN
  IF (SELECT state FROM otl.member_lifecycles WHERE user_id='UACTIVE')<>'dormant'
  THEN RAISE EXCEPTION 'backdated edit transitioned dormant member'; END IF;
END $$;
INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,reflection,resting)
VALUES('TLIFE','CLIFE','UACTIVE','2026-10-18','current return goal','pending','',false);
SELECT pg_temp.lifecycle_call('signal','{"teamId":"TLIFE","channelId":"CLIFE","userId":"UACTIVE","date":"2026-10-18","signal":"goal","now":"2026-10-18T01:00:01Z","expectedRevision":3,"key":"return-goal"}');
DO $$ BEGIN
  IF (SELECT state||':'||revision FROM otl.member_lifecycles WHERE user_id='UACTIVE')<>'active:4'
    OR (SELECT count(*) FROM otl.grass_seasons WHERE user_id='UACTIVE')<>2
    OR (SELECT count(*) FROM otl.grass_seasons WHERE user_id='UACTIVE' AND closed_at IS NULL)<>1
  THEN RAISE EXCEPTION 'current goal did not open exactly one return season'; END IF;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE otl.member_lifecycle_events SET result='{}' WHERE team_id='TLIFE' AND user_id='UACTIVE';
    RAISE EXCEPTION 'event mutation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='event mutation was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE otl.member_lifecycles SET origin_inviter_user_id='UFORGED' WHERE team_id='TLIFE' AND user_id='UACTIVE';
    RAISE EXCEPTION 'inviter mutation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='inviter mutation was accepted' THEN RAISE; END IF;
  END;
END $$;

CREATE TEMP TABLE qa_lifecycle_checks AS
SELECT * FROM (VALUES
  ('rollout-events',(SELECT count(*)=6 FROM otl.member_lifecycle_events
    WHERE team_id='TLIFE' AND event_type='rollout_seeded')),
  ('rollout-no-retro',(SELECT count(*)=6 FROM otl.member_lifecycle_events
    WHERE team_id='TLIFE' AND event_type='rollout_seeded' AND result->>'retroactiveCandidate'='false')),
  ('rollout-seasons',(SELECT count(*)=6 FROM otl.grass_seasons WHERE opened_reason='rollout')),
  ('preserved-day',(SELECT count(*)=1 FROM otl.community_days
    WHERE user_id='UACTIVE' AND day='2026-09-18' AND goal='preserved goal')),
  ('preserved-event',(SELECT count(*)=1 FROM otl.community_events WHERE event_key='preserved-event')),
  ('weekend-excluded',(SELECT exclusion_reason='weekend' FROM otl.lifecycle_service_days WHERE service_date='2026-09-20')),
  ('prompt-outage-excluded',(SELECT exclusion_reason='goal_prompt_missing' FROM otl.lifecycle_service_days WHERE service_date='2026-09-21')),
  ('join-only-excluded',(SELECT NOT eligible AND exclusion_reason='snapshot_missing'
    FROM otl.lifecycle_service_days WHERE service_date='2026-09-22')),
  ('join-only-used-prior-complete',(SELECT membership_observed_at='2026-09-21T09:00:00Z'
    FROM otl.lifecycle_service_days WHERE service_date='2026-09-22')),
  ('eligible-service-days',(SELECT count(*)=7 FROM otl.lifecycle_service_days WHERE eligible)),
  ('eligible-member-days',(SELECT count(*)=42 FROM otl.member_lifecycle_days WHERE eligible)),
  ('grace-events',(SELECT count(*)=6 FROM otl.member_lifecycle_events WHERE event_type='grace_started')),
  ('grace-deadline',(SELECT grace_deadline='2026-10-09' FROM otl.member_lifecycles WHERE user_id='UCONCURRENT')),
  ('service-replay',(SELECT count(*)=1 FROM otl.lifecycle_service_days WHERE service_date='2026-10-01')),
  ('grace-signals',(SELECT count(*)=4 FROM otl.member_lifecycle_events WHERE event_type='grace_cancelled')),
  ('signal-season-preserved',(SELECT count(*)=4 FROM otl.grass_seasons
    WHERE user_id IN ('UGOAL','UOUTCOME','UREFLECTION','UREST'))),
  ('extension-event',(SELECT count(*)=1 FROM otl.member_lifecycle_events WHERE event_type='grace_extended')),
  ('denied-events-absent',(SELECT count(*)=0 FROM otl.member_lifecycle_events
    WHERE event_key IN ('extension-2','early-expiry','stale-clock','stale-revision','rolled-back'))),
  ('expiry-event',(SELECT count(*)=1 FROM otl.member_lifecycle_events WHERE event_type='season_closed')),
  ('season-closed',(SELECT count(*)=1 FROM otl.grass_seasons WHERE user_id='UACTIVE' AND closed_reason='grace_expired')),
  ('dormant-rest-absent',(SELECT count(*)=0 FROM otl.member_lifecycle_events WHERE event_key='dormant-rest')),
  ('backdated-goal-absent',(SELECT count(*)=0 FROM otl.member_lifecycle_events WHERE event_key='backdated-goal')),
  ('reactivated',(SELECT count(*)=1 FROM otl.member_lifecycle_events WHERE event_type='reactivated')),
  ('one-open-return-season',(SELECT count(*)=1 FROM otl.grass_seasons WHERE user_id='UACTIVE' AND closed_at IS NULL)),
  ('immutable-event-intact',(SELECT count(*)>0 FROM otl.member_lifecycle_events
    WHERE user_id='UACTIVE' AND result<>'{}'::jsonb)),
  ('inviter-intact',(SELECT origin_inviter_user_id IS NULL FROM otl.member_lifecycles WHERE user_id='UACTIVE')),
  ('complete-snapshot-monotonic',(SELECT complete_membership_observed_at='2026-10-01T09:00:00Z'
    FROM otl.workspace_channels WHERE team_id='TLIFE' AND channel_id='CLIFE')),
  ('join-only-not-seeded',(SELECT count(*)=0 FROM otl.member_lifecycles WHERE user_id='UJOINONLY')),
  ('service-day-count',(SELECT count(*)=10 FROM otl.lifecycle_service_days)),
  ('member-day-count',(SELECT count(*)=60 FROM otl.member_lifecycle_days))
) checks(name,passed);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM qa_lifecycle_checks WHERE NOT coalesce(passed,false)) THEN
    RAISE EXCEPTION 'lifecycle state check failed: %',(
      SELECT string_agg(name,',' ORDER BY name) FROM qa_lifecycle_checks WHERE NOT coalesce(passed,false));
  END IF;
END $$;
SELECT 'JOIN_ONLY_ELIGIBLE='||eligible FROM otl.lifecycle_service_days WHERE service_date='2026-09-22';
SELECT 'EDGE_COUNT='||count(*) FROM qa_lifecycle_checks WHERE passed;
