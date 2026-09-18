BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:welcome-guide-roles:028',0));

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_guide_runtime') THEN
  CREATE ROLE otl_guide_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_guide_admin') THEN
  CREATE ROLE otl_guide_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
 END IF;
END $$;
ALTER ROLE otl_guide_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE otl_guide_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
DO $$ DECLARE membership record; BEGIN
 FOR membership IN
  SELECT parent.rolname AS parent_name,member.rolname AS member_name
  FROM pg_auth_members am JOIN pg_roles parent ON parent.oid=am.roleid
  JOIN pg_roles member ON member.oid=am.member
  WHERE member.rolname IN ('otl_guide_runtime','otl_guide_admin')
 LOOP
  EXECUTE format('REVOKE %I FROM %I',membership.parent_name,membership.member_name);
 END LOOP;
END $$;
REVOKE ALL ON SCHEMA otl FROM otl_guide_runtime,otl_guide_admin;
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM otl_guide_runtime,otl_guide_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM otl_guide_runtime,otl_guide_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otl FROM otl_guide_runtime,otl_guide_admin;
GRANT USAGE ON SCHEMA otl TO otl_guide_runtime,otl_guide_admin;

CREATE TABLE otl.guide_publishers (
 team_id text NOT NULL,
 channel_id text NOT NULL,
 user_id text NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,channel_id,user_id),
 FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
 FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id)
);
INSERT INTO otl.guide_publishers(team_id,channel_id,user_id)
 SELECT DISTINCT team_id,channel_id,author_id FROM otl.guide_versions WHERE status='published';

REVOKE ALL ON TABLE otl.guide_versions,otl.guide_deliveries,otl.guide_publishers
 FROM PUBLIC,otl_guide_runtime,otl_guide_admin;
REVOKE ALL ON FUNCTION otl.guide_execute(text,jsonb)
 FROM PUBLIC,otl_guide_runtime,otl_guide_admin;

CREATE FUNCTION otl.guide_runtime_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
 claimed boolean:=false; current_row otl.guide_versions%ROWTYPE;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'Guide scope required'; END IF;
 IF op='latest' THEN
  SELECT * INTO current_row FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND status='published';
  IF NOT FOUND THEN RAISE EXCEPTION 'Published guide not found'; END IF;
  RETURN jsonb_build_object('version',current_row.guide_version,'hash',current_row.content_hash,
   'body',current_row.body,'orderedFileIds',current_row.ordered_file_ids);
 ELSIF op='claim' THEN
  IF u !~ '^[UW][A-Z0-9]+$' OR
     p->>'version' !~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
     p->>'hash' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid guide delivery'; END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.guide_versions WHERE team_id=t AND channel_id=c AND
    guide_version=p->>'version' AND content_hash=p->>'hash' AND status='published')
  THEN RAISE EXCEPTION 'Published guide not found'; END IF;
  INSERT INTO otl.workspace_members(team_id,user_id) VALUES(t,u) ON CONFLICT DO NOTHING;
  INSERT INTO otl.guide_deliveries(team_id,channel_id,user_id,content_hash,guide_version,delivery_reason,status)
   VALUES(t,c,u,p->>'hash',p->>'version','join','claimed')
   ON CONFLICT DO NOTHING RETURNING true INTO claimed;
  RETURN to_jsonb(coalesce(claimed,false));
 ELSIF op='finish' THEN
  IF p->>'status' NOT IN ('sent','failed') THEN RAISE EXCEPTION 'Invalid guide delivery status'; END IF;
  UPDATE otl.guide_deliveries SET status=p->>'status',message_ts=p->>'messageTs',updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND guide_version=p->>'version' AND
    content_hash=p->>'hash' AND delivery_reason='join' AND status='claimed';
  RETURN to_jsonb(FOUND);
 END IF;
 RAISE EXCEPTION 'Invalid guide runtime operation';
END $$;

CREATE FUNCTION otl.guide_admin_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
 claimed boolean:=false; file_ids jsonb:=p->'orderedFileIds';
 current_row otl.guide_versions%ROWTYPE; existing_release otl.guide_versions%ROWTYPE;
 canonical_text text; computed_hash text;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'Guide scope required'; END IF;
 IF op='publish' THEN
  IF p->>'version' !~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
     p->>'hash' !~ '^[0-9a-f]{64}$' OR btrim(coalesce(p->>'body',''))='' OR
     length(p->>'body')>38000 OR p->>'body' ~ '<!(channel|here|everyone)>' OR
     p->>'authorId' !~ '^[UW][A-Z0-9]+$' OR p->>'sourceTs' !~ '^[0-9]+\.[0-9]+$' OR
     p->>'editedTs' !~ '^[0-9]+\.[0-9]+$' OR jsonb_typeof(file_ids)<>'array' OR
     jsonb_array_length(file_ids)<>2 OR file_ids->>0 !~ '^F[A-Z0-9]+$' OR
     file_ids->>1 !~ '^F[A-Z0-9]+$' OR file_ids->>0=file_ids->>1
  THEN RAISE EXCEPTION 'Invalid published guide'; END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.guide_publishers WHERE team_id=t AND channel_id=c AND user_id=p->>'authorId')
  THEN RAISE EXCEPTION 'Guide publisher is not registered'; END IF;
  canonical_text:='{"version":1,"body":'||to_json(p->>'body')::text||',"orderedFileIds":['||
   to_json(file_ids->>0)::text||','||to_json(file_ids->>1)::text||']}';
  computed_hash:=encode(public.digest(convert_to(canonical_text,'UTF8'),'sha256'),'hex');
  IF computed_hash<>p->>'hash' THEN RAISE EXCEPTION 'Guide canonical hash mismatch'; END IF;
  SELECT * INTO existing_release FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND guide_version=p->>'version';
  IF FOUND THEN
   IF existing_release.content_hash<>computed_hash OR existing_release.body<>p->>'body' OR
      existing_release.author_id<>p->>'authorId' OR existing_release.source_ts<>p->>'sourceTs' OR
      existing_release.source_edited_ts<>p->>'editedTs' OR existing_release.ordered_file_ids<>file_ids
   THEN RAISE EXCEPTION 'Guide version conflict'; END IF;
   RETURN to_jsonb(existing_release.content_hash);
  END IF;
  SELECT * INTO current_row FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND status='published' FOR UPDATE;
  IF FOUND THEN
   IF (substring(split_part(p->>'version','.',1) from 2)::int,
       split_part(p->>'version','.',2)::int,split_part(p->>'version','.',3)::int) <=
      (substring(split_part(current_row.guide_version,'.',1) from 2)::int,
       split_part(current_row.guide_version,'.',2)::int,split_part(current_row.guide_version,'.',3)::int)
   THEN RAISE EXCEPTION 'Guide version must increase'; END IF;
   IF (p->>'editedTs')::numeric <= current_row.source_edited_ts::numeric
   THEN RAISE EXCEPTION 'Guide source is stale'; END IF;
  END IF;
  UPDATE otl.guide_versions SET status='superseded' WHERE team_id=t AND channel_id=c AND status='published';
  INSERT INTO otl.guide_versions(team_id,channel_id,content_hash,body,author_id,source_ts,
   source_edited_ts,guide_version,ordered_file_ids,status,published_at)
   VALUES(t,c,computed_hash,p->>'body',p->>'authorId',p->>'sourceTs',p->>'editedTs',
    p->>'version',file_ids,'published',now());
  RETURN to_jsonb(computed_hash);
 ELSIF op='repair_latest' THEN
  SELECT * INTO current_row FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND status='published';
  IF NOT FOUND THEN RAISE EXCEPTION 'Published guide not found'; END IF;
  RETURN jsonb_build_object('version',current_row.guide_version,'hash',current_row.content_hash,
   'body',current_row.body,'orderedFileIds',current_row.ordered_file_ids);
 ELSIF op='repair_claim' THEN
  IF u !~ '^[UW][A-Z0-9]+$' OR p->>'version' !~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
     p->>'hash' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid guide repair'; END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.guide_versions WHERE team_id=t AND channel_id=c AND
    guide_version=p->>'version' AND content_hash=p->>'hash' AND status='published')
  THEN RAISE EXCEPTION 'Published guide not found'; END IF;
  INSERT INTO otl.workspace_members(team_id,user_id) VALUES(t,u) ON CONFLICT DO NOTHING;
  INSERT INTO otl.guide_deliveries(team_id,channel_id,user_id,content_hash,guide_version,delivery_reason,status)
   VALUES(t,c,u,p->>'hash',p->>'version','targeted_repair','claimed')
   ON CONFLICT DO NOTHING RETURNING true INTO claimed;
  RETURN to_jsonb(coalesce(claimed,false));
 ELSIF op='repair_finish' THEN
  IF p->>'status' NOT IN ('sent','failed') THEN RAISE EXCEPTION 'Invalid guide repair status'; END IF;
  UPDATE otl.guide_deliveries SET status=p->>'status',message_ts=p->>'messageTs',updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND guide_version=p->>'version' AND
    content_hash=p->>'hash' AND delivery_reason='targeted_repair' AND status='claimed';
  RETURN to_jsonb(FOUND);
 END IF;
 RAISE EXCEPTION 'Invalid guide admin operation';
END $$;

REVOKE ALL ON FUNCTION otl.guide_runtime_execute(text,jsonb),otl.guide_admin_execute(text,jsonb)
 FROM PUBLIC,otl_guide_runtime,otl_guide_admin;
GRANT EXECUTE ON FUNCTION otl.guide_runtime_execute(text,jsonb) TO otl_guide_runtime;
GRANT EXECUTE ON FUNCTION otl.guide_admin_execute(text,jsonb) TO otl_guide_admin;

INSERT INTO otl.schema_migrations(version) VALUES('028-welcome-guide-roles');
COMMIT;
