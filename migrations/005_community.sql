BEGIN;
CREATE TABLE IF NOT EXISTS otl.community_days (
  team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL, day date NOT NULL,
  goal text NOT NULL DEFAULT '', outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','complete','partial','not_done')),
  reflection text NOT NULL DEFAULT '', resting boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0,
  PRIMARY KEY(team_id,channel_id,user_id,day)
);
CREATE TABLE IF NOT EXISTS otl.community_events (
  team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL, event_key text NOT NULL,
  day date NOT NULL, before_state jsonb NOT NULL, after_revision integer NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(team_id,channel_id,user_id,event_key)
);
CREATE TABLE IF NOT EXISTS otl.community_milestones (
  team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL, kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team_id,channel_id,user_id,kind)
);
CREATE TABLE IF NOT EXISTS otl.community_preferences (
  team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, goal_time time NOT NULL DEFAULT '10:00', review_time time NOT NULL DEFAULT '18:00',
  PRIMARY KEY(team_id,channel_id,user_id)
);
CREATE TABLE IF NOT EXISTS otl.community_records (
  team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL, record_key text NOT NULL,
  kind text NOT NULL, body jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team_id,channel_id,user_id,record_key)
);

CREATE OR REPLACE FUNCTION otl.community_day_json(d otl.community_days) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('teamId',d.team_id,'channelId',d.channel_id,'userId',d.user_id,'date',d.day,
 'goal',d.goal,'outcome',d.outcome,'reflection',d.reflection,'resting',d.resting,'revision',d.revision)
$$;

CREATE OR REPLACE FUNCTION otl.community_execute(op text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
 t text := p->>'teamId'; c text := p->>'channelId'; u text := p->>'userId'; k text := p->>'key';
 dt date; d otl.community_days; previous jsonb; result jsonb; ev otl.community_events; rec otl.community_records;
 pref otl.community_preferences; a text := p->>'action'; first_goal boolean := false; first_review boolean := false;
 n integer; local_now timestamp; item record;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
 IF op IN ('due','list_days','members') THEN
   IF op='list_days' THEN
     RETURN (SELECT coalesce(jsonb_agg(otl.community_day_json(x)),'[]'::jsonb) FROM otl.community_days x WHERE team_id=t AND channel_id=c AND day=(p->>'date')::date);
   ELSIF op='members' THEN
     RETURN (SELECT coalesce(jsonb_agg(user_id),'[]'::jsonb) FROM (SELECT user_id FROM otl.community_days WHERE team_id=t AND channel_id=c UNION SELECT user_id FROM otl.community_preferences WHERE team_id=t AND channel_id=c) m);
   END IF;
   local_now := (p->>'now')::timestamptz AT TIME ZONE 'Asia/Seoul';
   dt := local_now::date;
   IF local_now::time < '08:00'::time OR local_now::time >= '22:00'::time THEN RETURN '[]'::jsonb; END IF;
   FOR item IN SELECT q.user_id, v.kind FROM otl.community_preferences q
     CROSS JOIN LATERAL (VALUES ('goal',q.goal_time),('review',q.review_time)) v(kind,due_time)
     LEFT JOIN otl.community_days x ON x.team_id=q.team_id AND x.channel_id=q.channel_id AND x.user_id=q.user_id AND x.day=dt
     WHERE q.team_id=t AND q.channel_id=c AND q.enabled AND local_now::time >= v.due_time
       AND local_now::time < '22:00'::time AND local_now::time >= '08:00'::time
       AND NOT coalesce(x.resting,false)
       AND ((v.kind='goal' AND coalesce(x.goal,'')='') OR (v.kind='review' AND coalesce(x.goal,'')<>'' AND coalesce(x.reflection,'')=''))
   LOOP
     INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
     VALUES(t,c,item.user_id,'reminder:'||dt||':'||item.kind,'reminder',jsonb_build_object('date',dt,'kind',item.kind)) ON CONFLICT DO NOTHING;
   END LOOP;
   RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('teamId',t,'channelId',c,'userId',r.user_id,'key',r.record_key,'date',r.body->>'date','kind',r.body->>'kind')),'[]'::jsonb)
     FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.status='pending' AND r.body->>'date'=dt::text);
 END IF;
 IF coalesce(u,'')='' THEN RAISE EXCEPTION 'owner required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u)::text,0));
 IF op='history' THEN
   RETURN (SELECT coalesce(jsonb_agg(otl.community_day_json(x) ORDER BY day),'[]'::jsonb) FROM otl.community_days x WHERE team_id=t AND channel_id=c AND user_id=u);
 END IF;
 IF op='set_group_schedule' THEN
   IF jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean'
     OR coalesce(p->>'goalTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR coalesce(p->>'reviewTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'invalid group schedule'; END IF;
   INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
   VALUES(t,c,u,'group-schedule','settings',jsonb_build_object('enabled',p->'enabled','goalTime',p->>'goalTime','reviewTime',p->>'reviewTime'))
   ON CONFLICT(team_id,channel_id,user_id,record_key) DO UPDATE SET body=excluded.body,updated_at=now();
   SELECT * INTO rec FROM otl.community_records WHERE team_id=t AND channel_id=c AND user_id=u AND record_key='group-schedule';
   RETURN jsonb_build_object('teamId',t,'channelId',c,'userId',u,'key',rec.record_key,'kind',rec.kind,'body',rec.body,'status',rec.status);
 END IF;
 IF op='list_records' THEN
   RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('teamId',t,'channelId',c,'userId',u,'key',record_key,'kind',kind,'body',body,'status',status)),'[]'::jsonb) FROM otl.community_records WHERE team_id=t AND channel_id=c AND user_id=u AND kind=p->>'kind');
 END IF;
 IF op='preferences' THEN
   INSERT INTO otl.community_preferences(team_id,channel_id,user_id) VALUES(t,c,u) ON CONFLICT DO NOTHING;
   UPDATE otl.community_preferences SET enabled=coalesce((p->>'enabled')::boolean,enabled),goal_time=coalesce((p->>'goalTime')::time,goal_time),review_time=coalesce((p->>'reviewTime')::time,review_time)
   WHERE team_id=t AND channel_id=c AND user_id=u RETURNING * INTO pref;
   IF NOT pref.enabled THEN UPDATE otl.community_records SET status='cancelled',updated_at=now() WHERE team_id=t AND channel_id=c AND user_id=u AND kind='reminder' AND status='pending'; END IF;
   RETURN jsonb_build_object('teamId',t,'channelId',c,'userId',u,'enabled',pref.enabled,'goalTime',to_char(pref.goal_time,'HH24:MI'),'reviewTime',to_char(pref.review_time,'HH24:MI'),'timezone','Asia/Seoul');
 END IF;
 IF op IN ('put_record','get_record','claim_record','finish_record','claim_reminder') THEN
   IF coalesce(k,'')='' THEN RAISE EXCEPTION 'key required'; END IF;
   IF op='put_record' THEN
     INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body) VALUES(t,c,u,k,p->>'kind',p->'body') ON CONFLICT DO NOTHING;
   END IF;
   SELECT * INTO rec FROM otl.community_records WHERE team_id=t AND channel_id=c AND user_id=u AND record_key=k;
   IF op IN ('put_record','get_record') THEN
     IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
     RETURN jsonb_build_object('teamId',t,'channelId',c,'userId',u,'key',k,'kind',rec.kind,'body',rec.body,'status',rec.status);
   END IF;
   IF op='claim_reminder' THEN
     local_now := coalesce((p->>'now')::timestamptz,now()) AT TIME ZONE 'Asia/Seoul';
     IF local_now::time < '08:00'::time OR local_now::time >= '22:00'::time
       OR rec.body->>'date' IS DISTINCT FROM local_now::date::text THEN RETURN 'false'::jsonb; END IF;
     SELECT * INTO pref FROM otl.community_preferences WHERE team_id=t AND channel_id=c AND user_id=u;
     SELECT * INTO d FROM otl.community_days WHERE team_id=t AND channel_id=c AND user_id=u AND day=(rec.body->>'date')::date;
     IF rec.kind IS DISTINCT FROM 'reminder' OR NOT coalesce(pref.enabled,false) OR coalesce(d.resting,false)
       OR ((rec.body->>'kind')='goal' AND coalesce(d.goal,'')<>'')
       OR ((rec.body->>'kind')='review' AND (coalesce(d.goal,'')='' OR coalesce(d.reflection,'')<>'')) THEN
       UPDATE otl.community_records SET status='cancelled',updated_at=now() WHERE team_id=t AND channel_id=c AND user_id=u AND record_key=k AND status='pending';
       RETURN 'false'::jsonb;
     END IF;
   END IF;
   IF op='finish_record' THEN
     IF p->>'status' NOT IN ('sent','failed','cancelled') THEN RAISE EXCEPTION 'invalid status'; END IF;
     UPDATE otl.community_records SET status=p->>'status',updated_at=now() WHERE team_id=t AND channel_id=c AND user_id=u AND record_key=k AND status='claimed';
   ELSE
     UPDATE otl.community_records SET status='claimed',updated_at=now() WHERE team_id=t AND channel_id=c AND user_id=u AND record_key=k AND status='pending';
   END IF;
   GET DIAGNOSTICS n=ROW_COUNT;
   RETURN to_jsonb(n=1);
 END IF;
 IF op NOT IN ('day','change') THEN RAISE EXCEPTION 'invalid operation'; END IF;
 dt := (p->>'date')::date;
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day) VALUES(t,c,u,dt) ON CONFLICT DO NOTHING;
 SELECT * INTO d FROM otl.community_days WHERE team_id=t AND channel_id=c AND user_id=u AND day=dt FOR UPDATE;
 IF op='day' THEN RETURN otl.community_day_json(d); END IF;
 IF coalesce(k,'')='' THEN RAISE EXCEPTION 'key required'; END IF;
 SELECT * INTO ev FROM otl.community_events WHERE team_id=t AND channel_id=c AND user_id=u AND event_key=k;
 IF FOUND THEN RETURN ev.result || jsonb_build_object('changed',false,'firstGoal',false,'firstReflection',false); END IF;
 previous := otl.community_day_json(d);
 IF (p ? 'expectedRevision' AND (p->>'expectedRevision')::integer<>d.revision) THEN
   RETURN jsonb_build_object('day',previous,'changed',false,'conflict',true,'firstGoal',false,'firstReflection',false,'undoKey','');
 END IF;
 CASE a
 WHEN 'goal' THEN
   IF length(btrim(coalesce(p->>'text','')))=0 OR length(p->>'text')>200 THEN RAISE EXCEPTION 'invalid goal'; END IF;
   d.goal := p->>'text'; d.outcome := 'pending'; d.resting := false;
 WHEN 'complete','partial','not_done' THEN
   IF d.goal='' THEN RAISE EXCEPTION 'goal required'; END IF;
   d.outcome := a; d.resting := false;
 WHEN 'reflection' THEN
   IF length(btrim(coalesce(p->>'text','')))=0 OR length(p->>'text')>2000 THEN RAISE EXCEPTION 'invalid reflection'; END IF;
   d.reflection := p->>'text';
   IF p ? 'outcome' THEN
     IF p->>'outcome' NOT IN ('pending','complete','partial','not_done') OR d.goal='' THEN RAISE EXCEPTION 'invalid reflection outcome'; END IF;
     d.outcome := p->>'outcome';
     IF d.outcome<>'pending' THEN d.resting := false; END IF;
   END IF;
 WHEN 'rest' THEN d.resting := true;
 WHEN 'undo' THEN
   SELECT * INTO ev FROM otl.community_events WHERE team_id=t AND channel_id=c AND user_id=u AND event_key=p->>'undoKey' AND day=dt;
   IF NOT FOUND OR ev.after_revision<>d.revision THEN RETURN jsonb_build_object('day',previous,'changed',false,'conflict',true,'firstGoal',false,'firstReflection',false,'undoKey',''); END IF;
   d.goal := ev.before_state->>'goal'; d.outcome := ev.before_state->>'outcome'; d.reflection := ev.before_state->>'reflection'; d.resting := (ev.before_state->>'resting')::boolean;
 ELSE RAISE EXCEPTION 'invalid action';
 END CASE;
 d.revision := d.revision+1;
 UPDATE otl.community_days SET goal=d.goal,outcome=d.outcome,reflection=d.reflection,resting=d.resting,revision=d.revision WHERE team_id=t AND channel_id=c AND user_id=u AND day=dt;
 IF coalesce((p->>'syncLegacy')::boolean,false) THEN
   IF d.goal<>'' THEN
     INSERT INTO otl.profiles(team_id,user_id,start_date) VALUES(t,u,dt) ON CONFLICT(team_id,user_id) DO NOTHING;
     PERFORM 1 FROM otl.profiles WHERE team_id=t AND user_id=u FOR UPDATE;
     UPDATE otl.profiles SET start_date=least(coalesce(start_date,dt),dt) WHERE team_id=t AND user_id=u;
     INSERT INTO otl.goals(team_id,user_id,goal_date,goal_text,completed,revision)
     VALUES(t,u,dt,d.goal,d.outcome='complete',extract(epoch FROM clock_timestamp()))
     ON CONFLICT(team_id,user_id,goal_date) DO UPDATE
       SET goal_text=excluded.goal_text,completed=excluded.completed,revision=excluded.revision;
   ELSIF a='undo' AND coalesce(previous->>'goal','')<>'' THEN
     PERFORM 1 FROM otl.profiles WHERE team_id=t AND user_id=u FOR UPDATE;
     DELETE FROM otl.goals WHERE team_id=t AND user_id=u AND goal_date=dt;
   END IF;
 END IF;
 IF a<>'undo' AND d.outcome='complete' THEN
   INSERT INTO otl.community_milestones VALUES(t,c,u,'first_goal',now()) ON CONFLICT DO NOTHING;
   GET DIAGNOSTICS n=ROW_COUNT; first_goal := n=1;
 END IF;
 IF a='reflection' THEN
   INSERT INTO otl.community_milestones VALUES(t,c,u,'first_reflection',now()) ON CONFLICT DO NOTHING;
   GET DIAGNOSTICS n=ROW_COUNT; first_review := n=1;
 END IF;
 UPDATE otl.community_records SET status='cancelled',updated_at=now() WHERE team_id=t AND channel_id=c AND user_id=u AND kind='reminder' AND status='pending' AND body->>'date'=dt::text
 AND (d.resting OR (body->>'kind'='goal' AND d.goal<>'') OR (body->>'kind'='review' AND d.reflection<>''));
 result := jsonb_build_object('day',otl.community_day_json(d),'changed',true,'conflict',false,'firstGoal',first_goal,'firstReflection',first_review,'undoKey',k);
 INSERT INTO otl.community_events VALUES(t,c,u,k,dt,previous,d.revision,result);
 RETURN result;
END;
$$;
COMMIT;
