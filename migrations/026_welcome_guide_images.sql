BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:welcome-guide-images:026',0));

ALTER TABLE otl.guide_versions
 ADD COLUMN guide_version text,
 ADD COLUMN ordered_file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN status text NOT NULL DEFAULT 'historical',
 ADD COLUMN published_at timestamptz;
ALTER TABLE otl.guide_versions
 ADD CONSTRAINT guide_versions_release_check CHECK (
  (status='historical' AND guide_version IS NULL AND ordered_file_ids='[]'::jsonb AND published_at IS NULL) OR
  (status IN ('published','superseded') AND guide_version ~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' AND
   published_at IS NOT NULL AND jsonb_typeof(ordered_file_ids)='array' AND
   jsonb_array_length(ordered_file_ids)=2 AND ordered_file_ids->>0 ~ '^F[A-Z0-9]+$' AND
   ordered_file_ids->>1 ~ '^F[A-Z0-9]+$' AND ordered_file_ids->>0 <> ordered_file_ids->>1)
 );
CREATE UNIQUE INDEX guide_versions_release_unique ON otl.guide_versions(team_id,channel_id,guide_version)
 WHERE guide_version IS NOT NULL;
CREATE UNIQUE INDEX guide_versions_one_published ON otl.guide_versions(team_id,channel_id)
 WHERE status='published';
ALTER TABLE otl.guide_versions
 ADD CONSTRAINT guide_versions_release_identity UNIQUE(team_id,channel_id,guide_version,content_hash);

ALTER TABLE otl.guide_deliveries
 ADD COLUMN guide_version text,
 ADD COLUMN delivery_reason text NOT NULL DEFAULT 'legacy';
ALTER TABLE otl.guide_deliveries DROP CONSTRAINT guide_deliveries_pkey;
ALTER TABLE otl.guide_deliveries
 ADD CONSTRAINT guide_deliveries_pkey PRIMARY KEY(team_id,channel_id,user_id,content_hash),
 ADD CONSTRAINT guide_deliveries_version_check CHECK (
  guide_version IS NULL OR guide_version ~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
 ),
 ADD CONSTRAINT guide_deliveries_reason_check CHECK (
  (delivery_reason='legacy' AND guide_version IS NULL) OR
  (delivery_reason IN ('join','targeted_repair') AND guide_version IS NOT NULL)
 ),
 ADD CONSTRAINT guide_deliveries_release_fk
  FOREIGN KEY(team_id,channel_id,guide_version,content_hash)
  REFERENCES otl.guide_versions(team_id,channel_id,guide_version,content_hash);

CREATE OR REPLACE FUNCTION otl.guide_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
 claimed boolean:=false; file_ids jsonb:=p->'orderedFileIds'; current_row otl.guide_versions%ROWTYPE;
 existing_release otl.guide_versions%ROWTYPE;
BEGIN
 IF op='publish' THEN
  IF p->>'version' !~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
     p->>'hash' !~ '^[0-9a-f]{64}$' OR btrim(coalesce(p->>'body',''))='' OR
     p->>'authorId' !~ '^[UW][A-Z0-9]+$' OR p->>'sourceTs' !~ '^[0-9]+\.[0-9]+$' OR
     p->>'editedTs' !~ '^[0-9]+\.[0-9]+$' OR jsonb_typeof(file_ids)<>'array' OR
     jsonb_array_length(file_ids)<>2 OR file_ids->>0 !~ '^F[A-Z0-9]+$' OR
     file_ids->>1 !~ '^F[A-Z0-9]+$' OR file_ids->>0=file_ids->>1
  THEN RAISE EXCEPTION 'Invalid published guide'; END IF;
  SELECT * INTO existing_release FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND guide_version=p->>'version';
  IF FOUND THEN
   IF existing_release.content_hash<>p->>'hash' OR existing_release.body<>p->>'body' OR
      existing_release.author_id<>p->>'authorId' OR existing_release.source_ts<>p->>'sourceTs' OR
      existing_release.source_edited_ts<>p->>'editedTs' OR existing_release.ordered_file_ids<>file_ids
   THEN RAISE EXCEPTION 'Guide version conflict'; END IF;
   RETURN to_jsonb(existing_release.content_hash);
  END IF;
  SELECT * INTO current_row FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND status='published' FOR UPDATE;
  IF FOUND THEN
   IF (substring(split_part(p->>'version','.',1) from 2)::int,
       split_part(p->>'version','.',2)::int,
       split_part(p->>'version','.',3)::int) <=
      (substring(split_part(current_row.guide_version,'.',1) from 2)::int,
       split_part(current_row.guide_version,'.',2)::int,
       split_part(current_row.guide_version,'.',3)::int)
   THEN RAISE EXCEPTION 'Guide version must increase'; END IF;
   IF (p->>'editedTs')::numeric <= current_row.source_edited_ts::numeric
   THEN RAISE EXCEPTION 'Guide source is stale'; END IF;
  END IF;
  INSERT INTO otl.workspaces(team_id) VALUES(t) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES(t,c) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_members(team_id,user_id) VALUES(t,p->>'authorId') ON CONFLICT DO NOTHING;
  UPDATE otl.guide_versions SET status='superseded' WHERE team_id=t AND channel_id=c AND status='published';
  INSERT INTO otl.guide_versions(team_id,channel_id,content_hash,body,author_id,source_ts,source_edited_ts,guide_version,ordered_file_ids,status,published_at)
   VALUES(t,c,p->>'hash',p->>'body',p->>'authorId',p->>'sourceTs',p->>'editedTs',p->>'version',file_ids,'published',now());
  RETURN to_jsonb(p->>'hash');
 ELSIF op='latest' THEN
  SELECT * INTO current_row FROM otl.guide_versions
   WHERE team_id=t AND channel_id=c AND status='published';
  IF NOT FOUND THEN RAISE EXCEPTION 'Published guide not found'; END IF;
  RETURN jsonb_build_object('version',current_row.guide_version,'hash',current_row.content_hash,
   'body',current_row.body,'orderedFileIds',current_row.ordered_file_ids);
	 ELSIF op='claim' THEN
	  IF p->>'version' !~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
	     p->>'hash' !~ '^[0-9a-f]{64}$' OR p->>'reason' NOT IN ('join','targeted_repair')
	  THEN RAISE EXCEPTION 'Invalid guide delivery'; END IF;
	  IF NOT EXISTS(SELECT 1 FROM otl.guide_versions WHERE team_id=t AND channel_id=c AND
	    guide_version=p->>'version' AND content_hash=p->>'hash' AND status='published')
	  THEN RAISE EXCEPTION 'Published guide not found'; END IF;
	  INSERT INTO otl.workspace_members(team_id,user_id) VALUES(t,u) ON CONFLICT DO NOTHING;
	  INSERT INTO otl.guide_deliveries(team_id,channel_id,user_id,content_hash,guide_version,delivery_reason,status)
	   VALUES(t,c,u,p->>'hash',p->>'version',p->>'reason','claimed')
	   ON CONFLICT DO NOTHING RETURNING true INTO claimed;
	  RETURN to_jsonb(coalesce(claimed,false));
	 ELSIF op='finish' THEN
	  IF p->>'status' NOT IN ('sent','failed') THEN RAISE EXCEPTION 'Invalid guide delivery status'; END IF;
	  UPDATE otl.guide_deliveries SET status=p->>'status',message_ts=p->>'messageTs',updated_at=now()
	   WHERE team_id=t AND channel_id=c AND user_id=u AND guide_version=p->>'version' AND
	    content_hash=p->>'hash' AND status='claimed';
  RETURN to_jsonb(FOUND);
 END IF;
 RAISE EXCEPTION 'Invalid guide operation';
END $$;

INSERT INTO otl.schema_migrations(version) VALUES('026-welcome-guide-images');
COMMIT;
