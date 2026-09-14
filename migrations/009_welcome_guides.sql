BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:welcome-guides:009',0));
CREATE TABLE otl.guide_versions (
 team_id text NOT NULL, channel_id text NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 body text NOT NULL CHECK(btrim(body)<>''), author_id text NOT NULL, source_ts text NOT NULL, source_edited_ts text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team_id,channel_id,content_hash),
 FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
 FOREIGN KEY(team_id,author_id) REFERENCES otl.workspace_members(team_id,user_id)
);
CREATE TABLE otl.guide_deliveries (
 team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL, content_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','sent','failed')),
 message_ts text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,channel_id,user_id),
 FOREIGN KEY(team_id,channel_id,content_hash) REFERENCES otl.guide_versions(team_id,channel_id,content_hash),
 FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id),
 CHECK(status<>'sent' OR message_ts IS NOT NULL)
);
CREATE FUNCTION otl.guide_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId'; claimed boolean:=false;
BEGIN
 IF op='claim' THEN
  INSERT INTO otl.workspaces(team_id) VALUES(t) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES(t,c) ON CONFLICT DO NOTHING;
  INSERT INTO otl.workspace_members(team_id,user_id) VALUES(t,u),(t,p->>'authorId') ON CONFLICT DO NOTHING;
  INSERT INTO otl.guide_versions(team_id,channel_id,content_hash,body,author_id,source_ts,source_edited_ts)
   VALUES(t,c,p->>'hash',p->>'body',p->>'authorId',p->>'sourceTs',p->>'editedTs') ON CONFLICT DO NOTHING;
  INSERT INTO otl.guide_deliveries(team_id,channel_id,user_id,content_hash,status)
   VALUES(t,c,u,p->>'hash','claimed') ON CONFLICT DO NOTHING RETURNING true INTO claimed;
  RETURN to_jsonb(coalesce(claimed,false));
 ELSIF op='finish' THEN
  IF p->>'status' NOT IN ('sent','failed') THEN RAISE EXCEPTION 'Invalid guide delivery status'; END IF;
  UPDATE otl.guide_deliveries SET status=p->>'status',message_ts=p->>'messageTs',updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND status='claimed';
  RETURN to_jsonb(FOUND);
 END IF;
 RAISE EXCEPTION 'Invalid guide operation';
END $$;
INSERT INTO otl.schema_migrations(version) VALUES('009-welcome-guides');
COMMIT;
