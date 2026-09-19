\set ON_ERROR_STOP on

INSERT INTO otl.workspaces(team_id,primary_goal_channel_id) VALUES('TDORM',NULL);
INSERT INTO otl.workspace_channels(team_id,channel_id,membership_observed_at,complete_membership_observed_at)
  VALUES('TDORM','CDORM','2026-09-19T01:00:00Z','2026-09-19T01:00:00Z');
UPDATE otl.workspaces SET primary_goal_channel_id='CDORM' WHERE team_id='TDORM';
INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted)
  VALUES('TDORM','UDORM','Dormant',false,false,false),('TDORM','URACE','Race',false,false,false);
INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
  VALUES('TDORM','CDORM','UDORM',true,'2026-09-19T01:00:00Z','2026-09-19T01:00:00Z'),
    ('TDORM','CDORM','URACE',true,'2026-09-19T01:00:00Z','2026-09-19T01:00:00Z');
INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,goal_time,review_time,eligible_from,preference_source)
  VALUES('TDORM','CDORM','UDORM',true,'08:00','18:00','2026-01-01','user'),
    ('TDORM','CDORM','URACE',true,'08:00','18:00','2026-01-01','user');
INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,reflection,revision)
  VALUES('TDORM','CDORM','UDORM','2026-09-01','preserved','complete','history',3),
    ('TDORM','CDORM','URACE','2026-09-01','preserved race','partial','history race',2);
INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,revision,rollout_at,last_transition_at)
  VALUES('TDORM','CDORM','UDORM','active',0,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z'),
    ('TDORM','CDORM','URACE','active',0,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
  VALUES('TDORM','CDORM','UDORM','2026-09-01T00:00:00Z','2026-09-01','rollout'),
    ('TDORM','CDORM','URACE','2026-09-01T00:00:00Z','2026-09-01','rollout');
INSERT INTO otl.member_referral_links(team_id,link_id,referrer_user_id,token_digest,status,created_at,status_changed_at)
  VALUES('TDORM','LNK-DORM','UDORM',repeat('a',64),'active','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z'),
    ('TDORM','LNK-RACE','URACE',repeat('b',64),'active','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status)
  VALUES('TDORM','CDORM','UDORM','reminder:2026-09-19:goal','reminder',
    '{"date":"2026-09-19","kind":"goal"}','pending');
INSERT INTO otl.lifecycle_notice_outbox(team_id,channel_id,user_id,effect_key,notice_kind,lifecycle_revision,
  scheduled_at,payload,created_at,updated_at)
  VALUES('TDORM','CDORM','UDORM','closure:1','closure',1,'2026-09-19T00:00:00Z','{}',
    '2026-09-19T00:00:00Z','2026-09-19T00:00:00Z');

CREATE TEMP TABLE dormant_hashes AS SELECT
  md5((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id)::text FROM otl.community_preferences p WHERE team_id='TDORM')) pref_hash,
  md5((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.user_id,d.day)::text FROM otl.community_days d WHERE team_id='TDORM')) history_hash;

UPDATE otl.grass_seasons SET closed_at='2026-09-18T00:00:00Z',closed_on='2026-09-18',closed_reason='grace_expired'
  WHERE team_id='TDORM';
UPDATE otl.member_lifecycles SET state='dormant',revision=1,last_transition_at='2026-09-18T00:00:00Z'
  WHERE team_id='TDORM';

DO $$
DECLARE before_count integer; result jsonb;
BEGIN
  IF otl.community_execute('members','{"teamId":"TDORM","channelId":"CDORM"}')<>'[]'::jsonb
    THEN RAISE EXCEPTION 'dormant roster leak'; END IF;
  IF otl.community_execute('list_days','{"teamId":"TDORM","channelId":"CDORM","date":"2026-09-01"}')<>'[]'::jsonb
    THEN RAISE EXCEPTION 'dormant active-count leak'; END IF;
  IF otl.reminder_eligible('TDORM','CDORM','UDORM','goal','2026-09-19 10:00')
    THEN RAISE EXCEPTION 'dormant reminder leak'; END IF;
  IF (otl.referral_runtime_execute('resolve',jsonb_build_object('teamId','TDORM','tokenDigest',repeat('a',64)))->>'available')::boolean
    THEN RAISE EXCEPTION 'dormant referral leak'; END IF;
  IF otl.community_execute('route_review_garden','{"teamId":"TDORM","channelId":"CDORM","userId":"UDORM","date":"2026-09-19","sourceTs":"1.1"}')<>'null'::jsonb
    THEN RAISE EXCEPTION 'dormant garden leak'; END IF;
  SELECT count(*) INTO before_count FROM otl.community_days WHERE team_id='TDORM' AND day='2026-09-19';
  BEGIN
    PERFORM otl.community_execute('change','{"teamId":"TDORM","channelId":"CDORM","userId":"UDORM","date":"2026-09-19","key":"rest","action":"rest","expectedLifecycleRevision":1,"now":"2026-09-19T01:00:00Z"}');
    RAISE EXCEPTION 'dormant rest accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='dormant rest accepted' THEN RAISE; END IF; END;
  BEGIN
    PERFORM otl.community_execute('change','{"teamId":"TDORM","channelId":"CDORM","userId":"UDORM","date":"2026-09-19","key":"reflection","action":"reflection","text":"late","expectedLifecycleRevision":1,"now":"2026-09-19T01:00:00Z"}');
    RAISE EXCEPTION 'dormant reflection accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='dormant reflection accepted' THEN RAISE; END IF; END;
  BEGIN
    PERFORM otl.community_execute('change','{"teamId":"TDORM","channelId":"CDORM","userId":"UDORM","date":"2026-09-18","key":"old","action":"goal","text":"old","expectedLifecycleRevision":1,"now":"2026-09-19T01:00:00Z"}');
    RAISE EXCEPTION 'old goal accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='old goal accepted' THEN RAISE; END IF; END;
  BEGIN
    PERFORM otl.community_execute('change','{"teamId":"TDORM","channelId":"CDORM","userId":"UDORM","date":"2026-09-19","key":"stale","action":"goal","text":"stale","expectedLifecycleRevision":0,"now":"2026-09-19T01:00:00Z"}');
    RAISE EXCEPTION 'stale lifecycle goal accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='stale lifecycle goal accepted' THEN RAISE; END IF; END;
  UPDATE otl.workspace_channel_memberships SET is_current=false WHERE team_id='TDORM' AND user_id='UDORM';
  UPDATE otl.workspace_channel_memberships SET is_current=true WHERE team_id='TDORM' AND user_id='UDORM';
  IF (SELECT state FROM otl.member_lifecycles WHERE team_id='TDORM' AND user_id='UDORM')<>'dormant'
    THEN RAISE EXCEPTION 'channel rejoin reactivated member'; END IF;
  IF (SELECT count(*) FROM otl.community_days WHERE team_id='TDORM' AND day='2026-09-19')<>before_count
    THEN RAISE EXCEPTION 'denied action created current row'; END IF;
  result:=otl.community_execute('change','{"teamId":"TDORM","channelId":"CDORM","userId":"UDORM","date":"2026-09-19","key":"return","action":"goal","text":"new season","expectedRevision":0,"expectedLifecycleRevision":1,"now":"2026-09-19T01:00:00Z"}');
  IF result->'returnTransition'->>'kind'<>'welcome_back' THEN RAISE EXCEPTION 'typed receipt missing'; END IF;
  IF (SELECT state||':'||revision FROM otl.member_lifecycles WHERE user_id='UDORM')<>'active:2'
    OR (SELECT count(*) FROM otl.grass_seasons WHERE user_id='UDORM' AND closed_at IS NULL)<>1
    OR (SELECT count(*) FROM otl.grass_seasons WHERE user_id='UDORM')<>2
    THEN RAISE EXCEPTION 'return boundary incomplete'; END IF;
  IF (SELECT link_id||':'||status FROM otl.member_referral_links WHERE referrer_user_id='UDORM')<>'LNK-DORM:active'
    THEN RAISE EXCEPTION 'referral slug not restored'; END IF;
  IF (SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE user_id='UDORM' AND notice_kind='return' AND status='pending')<>1
    OR (SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE user_id='UDORM' AND notice_kind='closure' AND status='cancelled')<>1
    THEN RAISE EXCEPTION 'welcome receipt boundary invalid'; END IF;
  IF (SELECT pref_hash FROM dormant_hashes)<>md5((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id)::text FROM otl.community_preferences p WHERE team_id='TDORM'))
    THEN RAISE EXCEPTION 'preferences changed'; END IF;
  IF (SELECT history_hash FROM dormant_hashes)<>md5((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.user_id,d.day)::text FROM otl.community_days d WHERE team_id='TDORM' AND day<'2026-09-19'))
    THEN RAISE EXCEPTION 'history changed'; END IF;
END $$;

SELECT 'SURFACE_COUNTS='||(SELECT count(*) FROM otl.member_lifecycles WHERE team_id='TDORM' AND state='dormant')||
  ':RETURN_SEASONS='||(SELECT count(*) FROM otl.grass_seasons WHERE team_id='TDORM' AND opened_reason='return')||
  ':WELCOME='||(SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE team_id='TDORM' AND notice_kind='return');
