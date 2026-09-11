-- Apply with 007 in one transaction; never deploy this file independently.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:normalization:006',0));
LOCK TABLE otl.profiles, otl.goals, otl.community_days, otl.community_events,
  otl.community_milestones, otl.community_preferences, otl.community_records IN ACCESS EXCLUSIVE MODE;

CREATE SCHEMA otl_archive;
REVOKE ALL ON SCHEMA otl_archive FROM PUBLIC;
CREATE TABLE otl_archive.migration_snapshots (
 migration text NOT NULL, table_name text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(),
 rows jsonb NOT NULL, PRIMARY KEY(migration,table_name)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['profiles','goals','community_days','community_events','community_milestones','community_preferences','community_records'] LOOP
 EXECUTE format('INSERT INTO otl_archive.migration_snapshots(migration,table_name,rows) SELECT ''006'',%L,coalesce(jsonb_agg(to_jsonb(x)),''[]''::jsonb) FROM otl.%I x',tab,tab);
 END LOOP;
END $$;

CREATE TABLE otl.workspaces (
 team_id text PRIMARY KEY CHECK (btrim(team_id)<>''),
 primary_goal_channel_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE otl.workspace_members (
 team_id text NOT NULL REFERENCES otl.workspaces(team_id),
 user_id text NOT NULL CHECK (btrim(user_id)<>''),
 display_name text, is_bot boolean, slack_deleted boolean,
 directory_synced_at timestamptz,
 first_observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,user_id)
);
CREATE TABLE otl.workspace_channels (
 team_id text NOT NULL REFERENCES otl.workspaces(team_id),
 channel_id text NOT NULL CHECK (btrim(channel_id)<>''),
 PRIMARY KEY(team_id,channel_id)
);
ALTER TABLE otl.workspaces ADD CONSTRAINT workspaces_primary_channel_fk
 FOREIGN KEY(team_id,primary_goal_channel_id) REFERENCES otl.workspace_channels(team_id,channel_id);

INSERT INTO otl.workspaces(team_id)
 SELECT team_id FROM otl.profiles UNION SELECT team_id FROM otl.community_days
 UNION SELECT team_id FROM otl.community_records UNION SELECT team_id FROM otl.community_events
 UNION SELECT team_id FROM otl.community_preferences UNION SELECT team_id FROM otl.community_milestones;
INSERT INTO otl.workspace_members(team_id,user_id)
 SELECT team_id,user_id FROM otl.profiles UNION SELECT team_id,user_id FROM otl.community_days
 UNION SELECT team_id,user_id FROM otl.community_records UNION SELECT team_id,user_id FROM otl.community_events
 UNION SELECT team_id,user_id FROM otl.community_preferences UNION SELECT team_id,user_id FROM otl.community_milestones;
INSERT INTO otl.workspace_channels(team_id,channel_id)
 SELECT team_id,channel_id FROM otl.community_days UNION SELECT team_id,channel_id FROM otl.community_records
 UNION SELECT team_id,channel_id FROM otl.community_events UNION SELECT team_id,channel_id FROM otl.community_preferences
 UNION SELECT team_id,channel_id FROM otl.community_milestones;
-- Fresh installs contain no goals. Existing installations must supply an explicitly
-- reviewed workspace/channel mapping here before importing legacy goals.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM otl.goals g JOIN otl.workspaces w USING(team_id) WHERE w.primary_goal_channel_id IS NULL)
 THEN RAISE EXCEPTION 'Explicit primary goal channel mapping required for every existing workspace'; END IF;
END $$;

CREATE TABLE otl_archive.goal_reconciliation (
 team_id text NOT NULL,user_id text NOT NULL,day date NOT NULL,
 canonical_before jsonb,legacy_before jsonb,decision text NOT NULL,source_url text,
 PRIMARY KEY(team_id,user_id,day)
);
INSERT INTO otl_archive.goal_reconciliation
 SELECT d.team_id,d.user_id,d.day,to_jsonb(d),to_jsonb(g),
 CASE WHEN g.user_id IS NULL THEN 'canonical_preserved_missing_legacy' ELSE 'canonical_preserved_verified_slack_source' END,
 NULL::text
 FROM otl.community_days d JOIN otl.workspaces w ON w.team_id=d.team_id AND w.primary_goal_channel_id=d.channel_id
 LEFT JOIN otl.goals g ON g.team_id=d.team_id AND g.user_id=d.user_id AND g.goal_date=d.day
 WHERE d.goal<>'' AND (g.user_id IS NULL OR d.goal<>g.goal_text OR (d.outcome='complete')<>g.completed);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM otl_archive.goal_reconciliation WHERE legacy_before IS NOT NULL)
 THEN RAISE EXCEPTION 'Unreviewed source disagreement; reconcile explicitly before migration'; END IF;
END $$;

ALTER TABLE otl.community_days ADD COLUMN last_event_time numeric NOT NULL DEFAULT -1
 CHECK(last_event_time >= -1 AND last_event_time::text NOT IN ('NaN','Infinity','-Infinity'));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM otl.goals g JOIN otl.workspaces w USING(team_id)
 JOIN otl.community_days d ON d.team_id=g.team_id AND d.channel_id=w.primary_goal_channel_id AND d.user_id=g.user_id AND d.day=g.goal_date
 WHERE d.goal='') THEN RAISE EXCEPTION 'Blank canonical goal conflicts with legacy goal; reconcile before migration'; END IF;
END $$;
-- Only absent canonical days are imported; existing canonical content is never overwritten.
INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,last_event_time)
 SELECT g.team_id,w.primary_goal_channel_id,g.user_id,g.goal_date,g.goal_text,
 CASE WHEN g.completed THEN 'complete' ELSE 'pending' END,g.revision
 FROM otl.goals g JOIN otl.workspaces w USING(team_id)
 ON CONFLICT(team_id,channel_id,user_id,day) DO NOTHING;
UPDATE otl.community_days d SET last_event_time=greatest(d.last_event_time,g.revision)
 FROM otl.goals g,otl.workspaces w
 WHERE g.team_id=d.team_id AND g.user_id=d.user_id AND g.goal_date=d.day
 AND w.team_id=d.team_id AND w.primary_goal_channel_id=d.channel_id;
UPDATE otl.community_days SET last_event_time=greatest(last_event_time,extract(epoch FROM transaction_timestamp()));

CREATE FUNCTION otl.ensure_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
 INSERT INTO otl.workspaces(team_id) VALUES(NEW.team_id) ON CONFLICT DO NOTHING;
 INSERT INTO otl.workspace_members(team_id,user_id) VALUES(NEW.team_id,NEW.user_id) ON CONFLICT DO NOTHING;
 IF TG_TABLE_NAME<>'profiles' THEN
  INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES(NEW.team_id,NEW.channel_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['profiles','community_days','community_events','community_milestones','community_preferences','community_records'] LOOP
 EXECUTE format('ALTER TABLE otl.%I ADD CONSTRAINT %I FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id)',tab,tab||'_member_fk');
 IF tab<>'profiles' THEN
 EXECUTE format('ALTER TABLE otl.%I ADD CONSTRAINT %I FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id)',tab,tab||'_channel_fk');
 END IF;
 EXECUTE format('CREATE TRIGGER ensure_identity BEFORE INSERT ON otl.%I FOR EACH ROW EXECUTE FUNCTION otl.ensure_identity()',tab);
 END LOOP;
END $$;
CREATE INDEX community_days_member_history ON otl.community_days(team_id,user_id,day);
CREATE INDEX community_records_kind ON otl.community_records(team_id,channel_id,user_id,kind);
CREATE INDEX community_records_pending ON otl.community_records(team_id,channel_id,kind,status) WHERE status='pending';

CREATE TABLE otl.channel_schedules (
 team_id text NOT NULL,channel_id text NOT NULL,updated_by text NOT NULL,
 enabled boolean NOT NULL,goal_time time NOT NULL,review_time time NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,channel_id),
 FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
 FOREIGN KEY(team_id,updated_by) REFERENCES otl.workspace_members(team_id,user_id)
);
INSERT INTO otl.channel_schedules
 SELECT team_id,channel_id,user_id,(body->>'enabled')::boolean,(body->>'goalTime')::time,(body->>'reviewTime')::time,updated_at
 FROM otl.community_records WHERE record_key='group-schedule' AND kind='settings';
DELETE FROM otl.community_records WHERE record_key='group-schedule' AND kind='settings';

ALTER TABLE otl.goals SET SCHEMA otl_archive;
CREATE VIEW otl.goals AS
 SELECT d.team_id,d.user_id,d.day AS goal_date,d.goal AS goal_text,(d.outcome='complete') AS completed,d.last_event_time AS revision
 FROM otl.community_days d JOIN otl.workspaces w ON w.team_id=d.team_id AND w.primary_goal_channel_id=d.channel_id WHERE d.goal<>'';

-- Preserve the old functions for rollback while replacing both entry points atomically.
ALTER FUNCTION otl.execute(text,text,date,text,date,text,jsonb,numeric) RENAME TO execute_v1;
ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_v1;
DO $$ DECLARE definition text; start_at integer; stop_at integer; BEGIN
 definition := pg_get_functiondef('otl.community_execute_v1(text,jsonb)'::regprocedure);
 definition := replace(definition,'otl.community_execute_v1(','otl.community_execute_core(');
 start_at := strpos(definition,' IF coalesce((p->>''syncLegacy'')::boolean,false) THEN');
 stop_at := strpos(definition,' IF a<>''undo'' AND d.outcome=''complete'' THEN');
 IF start_at=0 OR stop_at<=start_at THEN RAISE EXCEPTION 'Unexpected community function source'; END IF;
 definition := substr(definition,1,start_at-1)||substr(definition,stop_at);
 definition := replace(definition,'length(p->>''text'')>200 THEN','length(p->>''text'')>(CASE WHEN p ? ''legacyEventTime'' THEN 500 ELSE 200 END) THEN');
 definition := replace(definition,'d.goal := p->>''text''; d.outcome := ''pending''; d.resting := false;',
 'd.goal := p->>''text''; IF NOT coalesce((p->>''preserveOutcome'')::boolean,false) THEN d.outcome := ''pending''; d.resting := false; END IF;');
 definition := replace(definition,' WHEN ''complete'',''partial'',''not_done'' THEN',
 ' WHEN ''reopen'' THEN IF d.goal='''' THEN RAISE EXCEPTION ''goal required''; END IF; d.outcome := ''pending''; d.resting := false; WHEN ''complete'',''partial'',''not_done'' THEN');
 EXECUTE definition;
END $$;

CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId';c text:=p->>'channelId';u text:=p->>'userId';r jsonb;s otl.channel_schedules;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
 IF coalesce(u,'')<>'' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,u)::text,1));
 END IF;
 IF op='set_group_schedule' THEN
  IF coalesce(u,'')='' OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean'
   OR coalesce(p->>'goalTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   OR coalesce(p->>'reviewTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'invalid group schedule'; END IF;
  INSERT INTO otl.workspaces(team_id) VALUES(t) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_members(team_id,user_id) VALUES(t,u) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES(t,c) ON CONFLICT DO NOTHING;
  INSERT INTO otl.channel_schedules VALUES(t,c,u,(p->>'enabled')::boolean,(p->>'goalTime')::time,(p->>'reviewTime')::time,now())
   ON CONFLICT(team_id,channel_id) DO UPDATE SET updated_by=excluded.updated_by,enabled=excluded.enabled,goal_time=excluded.goal_time,review_time=excluded.review_time,updated_at=now();
 END IF;
 IF op='set_group_schedule' OR (op='get_record' AND p->>'key'='group-schedule') THEN
  SELECT * INTO s FROM otl.channel_schedules WHERE team_id=t AND channel_id=c AND updated_by=u;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  RETURN jsonb_build_object('teamId',t,'channelId',c,'userId',u,'key','group-schedule','kind','settings','status','pending',
   'body',jsonb_build_object('enabled',s.enabled,'goalTime',to_char(s.goal_time,'HH24:MI'),'reviewTime',to_char(s.review_time,'HH24:MI')));
 END IF;
 IF op='put_record' AND p->>'key'='group-schedule' THEN RAISE EXCEPTION 'Use set_group_schedule'; END IF;
 r:=otl.community_execute_core(op,p-'syncLegacy');
 IF op='change' AND coalesce((r->>'changed')::boolean,false) THEN
  IF r->'day'->>'goal'<>'' AND EXISTS(SELECT 1 FROM otl.workspaces WHERE team_id=t AND primary_goal_channel_id=c) THEN
   INSERT INTO otl.profiles(team_id,user_id,start_date) VALUES(t,u,(p->>'date')::date)
   ON CONFLICT(team_id,user_id) DO UPDATE SET start_date=least(otl.profiles.start_date,excluded.start_date);
  END IF;
  UPDATE otl.community_days SET last_event_time=greatest(last_event_time,coalesce((p->>'legacyEventTime')::numeric,extract(epoch FROM clock_timestamp())))
   WHERE team_id=t AND channel_id=c AND user_id=u AND day=(p->>'date')::date;
 END IF;
 RETURN r;
END $$;
ALTER FUNCTION otl.community_execute_core(text,jsonb) SET search_path=pg_catalog,otl;
REVOKE EXECUTE ON FUNCTION otl.community_execute_core(text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.community_execute_v1(text,jsonb),otl.execute_v1(text,text,date,text,date,text,jsonb,numeric) FROM PUBLIC;
CREATE TABLE otl.schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO otl.schema_migrations(version) VALUES('006-007-normalization');
