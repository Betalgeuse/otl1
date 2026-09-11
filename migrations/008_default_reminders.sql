BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:default-reminders:008',0));
LOCK TABLE otl.community_preferences IN ACCESS EXCLUSIVE MODE;
INSERT INTO otl_archive.migration_snapshots(migration,table_name,rows)
 SELECT '008','community_preferences',coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM otl.community_preferences p;
ALTER TABLE otl.community_preferences
 ADD COLUMN preference_source text NOT NULL DEFAULT 'legacy' CHECK(preference_source IN ('legacy','default','user')),
 ADD COLUMN eligible_from date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Seoul')::date + 1),
 ALTER COLUMN goal_time SET DEFAULT '11:00',
 ALTER COLUMN review_time SET DEFAULT '20:00';
UPDATE otl.community_preferences SET preference_source='user'
 WHERE enabled OR goal_time<>'10:00'::time OR review_time<>'18:00'::time;

CREATE FUNCTION otl.reminder_eligible(t text,c text,u text,kind text,local_now timestamp)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
 SELECT EXISTS (
 SELECT 1 FROM otl.community_preferences p
 JOIN otl.workspace_members m USING(team_id,user_id)
 LEFT JOIN otl.community_days d ON d.team_id=p.team_id AND d.channel_id=p.channel_id AND d.user_id=p.user_id AND d.day=local_now::date
 WHERE p.team_id=t AND p.channel_id=c AND p.user_id=u AND p.enabled
 AND p.eligible_from<=local_now::date AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.slack_deleted,false)
 AND extract(isodow FROM local_now)<6 AND local_now::time>='08:00'::time AND local_now::time<'22:00'::time
 AND NOT coalesce(d.resting,false)
 AND ((kind='goal' AND local_now::time>=p.goal_time AND coalesce(d.goal,'')='')
   OR (kind='review' AND local_now::time>=p.review_time AND coalesce(d.goal,'')<>'' AND coalesce(d.reflection,'')=''))
 )
$$;
REVOKE EXECUTE ON FUNCTION otl.reminder_eligible(text,text,text,text,timestamp) FROM PUBLIC;
ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_reminder_defaults;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_reminder_defaults(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
 pref otl.community_preferences; local_now timestamp; rec otl.community_records;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
 IF op IN ('preferences','enroll_reminders','claim_reminder') THEN
  IF coalesce(u,'')='' THEN RAISE EXCEPTION 'owner required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,u)::text,1));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u)::text,0));
 END IF;
 IF op IN ('preferences','enroll_reminders') THEN
  INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source)
   VALUES(t,c,u,EXISTS(SELECT 1 FROM otl.workspaces WHERE team_id=t AND primary_goal_channel_id=c),'default')
   ON CONFLICT DO NOTHING;
  IF op='preferences' AND p ?| ARRAY['enabled','goalTime','reviewTime'] THEN
   UPDATE otl.community_preferences SET enabled=coalesce((p->>'enabled')::boolean,enabled),
    goal_time=coalesce((p->>'goalTime')::time,goal_time),review_time=coalesce((p->>'reviewTime')::time,review_time),preference_source='user'
    WHERE team_id=t AND channel_id=c AND user_id=u;
  END IF;
  SELECT * INTO pref FROM otl.community_preferences WHERE team_id=t AND channel_id=c AND user_id=u;
  IF NOT pref.enabled THEN
   UPDATE otl.community_records SET status='cancelled',updated_at=now()
    WHERE team_id=t AND channel_id=c AND user_id=u AND kind='reminder' AND status='pending';
  END IF;
  RETURN jsonb_build_object('teamId',t,'channelId',c,'userId',u,'enabled',pref.enabled,
   'goalTime',to_char(pref.goal_time,'HH24:MI'),'reviewTime',to_char(pref.review_time,'HH24:MI'),
   'timezone','Asia/Seoul','eligibleFrom',pref.eligible_from,'preferenceSource',pref.preference_source);
 END IF;
 IF op='due' THEN
  local_now:=(p->>'now')::timestamptz AT TIME ZONE 'Asia/Seoul';
  INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
   SELECT t,c,q.user_id,'reminder:'||local_now::date||':'||v.kind,'reminder',jsonb_build_object('date',local_now::date,'kind',v.kind)
   FROM otl.community_preferences q CROSS JOIN (VALUES('goal'),('review')) v(kind)
   WHERE q.team_id=t AND q.channel_id=c AND otl.reminder_eligible(t,c,q.user_id,v.kind,local_now)
   ON CONFLICT DO NOTHING;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('teamId',t,'channelId',c,'userId',r.user_id,
   'key',r.record_key,'date',r.body->>'date','kind',r.body->>'kind')),'[]'::jsonb)
   FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.status='pending'
   AND r.body->>'date'=local_now::date::text AND otl.reminder_eligible(t,c,r.user_id,r.body->>'kind',local_now));
 END IF;
 IF op='claim_reminder' THEN
  local_now:=coalesce((p->>'now')::timestamptz,now()) AT TIME ZONE 'Asia/Seoul';
  SELECT * INTO rec FROM otl.community_records WHERE team_id=t AND channel_id=c AND user_id=u AND record_key=p->>'key';
  IF NOT FOUND OR rec.kind<>'reminder' OR rec.body->>'date' IS DISTINCT FROM local_now::date::text
   OR NOT otl.reminder_eligible(t,c,u,rec.body->>'kind',local_now) THEN RETURN 'false'::jsonb; END IF;
 END IF;
 RETURN otl.community_execute_before_reminder_defaults(op,p);
END $$;
INSERT INTO otl.schema_migrations(version) VALUES('008-default-reminders');
COMMIT;
