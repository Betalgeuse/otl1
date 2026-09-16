BEGIN;

CREATE TABLE IF NOT EXISTS otl.member_introductions (
  team_id text NOT NULL,
  user_id text NOT NULL,
  intro text NOT NULL DEFAULT '',
  linkedin text,
  channel_id text,
  message_ts text,
  revision integer NOT NULL DEFAULT 0,
  pending_token text,
  pending_intro text,
  pending_linkedin text,
  pending_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  CHECK (intro = '' OR (char_length(intro) BETWEEN 1 AND 180 AND intro !~ E'[\r\n]')),
  CHECK (linkedin IS NULL OR linkedin ~ '^https://([A-Za-z0-9-]+\.)*linkedin\.com/in/[^/?#]+/?$'),
  CHECK (message_ts IS NULL OR message_ts ~ '^[0-9]+\.[0-9]{6}$')
);

INSERT INTO otl.member_introductions (
  team_id, user_id, intro, linkedin, channel_id, message_ts, revision
)
SELECT
  r.team_id,
  r.user_id,
  regexp_replace(left(r.body->>'intro', 180), E'[\r\n]+', ' ', 'g'),
  nullif(r.body->>'linkedin', ''),
  r.channel_id,
  delivery.body->>'messageTs',
  1
FROM otl.community_records r
LEFT JOIN LATERAL (
  SELECT d.body
  FROM otl.community_records d
  WHERE d.team_id = r.team_id
    AND d.channel_id = r.channel_id
    AND d.user_id = r.user_id
    AND d.kind = 'self_introduction_delivery'
  ORDER BY d.updated_at DESC
  LIMIT 1
) delivery ON true
WHERE r.kind = 'self_introduction'
  AND r.status = 'sent'
  AND coalesce(r.body->>'intro', '') <> ''
ON CONFLICT (team_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION otl.introduction_json(i otl.member_introductions)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'teamId', i.team_id,
    'userId', i.user_id,
    'intro', i.intro,
    'linkedin', i.linkedin,
    'channelId', i.channel_id,
    'messageTs', i.message_ts,
    'revision', i.revision
  )
$$;

CREATE OR REPLACE FUNCTION otl.introduction_execute(op text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE
  t text := p->>'teamId';
  u text := p->>'userId';
  token text := p->>'token';
  expected integer;
  i otl.member_introductions;
  changed integer;
BEGIN
  IF coalesce(t, '') = '' OR (op <> 'list' AND coalesce(u, '') = '')
  THEN RAISE EXCEPTION 'scope required'; END IF;

  IF op = 'get' THEN
    SELECT * INTO i FROM otl.member_introductions WHERE team_id = t AND user_id = u;
    IF NOT FOUND OR i.intro = '' THEN RETURN 'null'::jsonb; END IF;
    RETURN otl.introduction_json(i);
  END IF;

  IF op = 'list' THEN
    RETURN (
      SELECT coalesce(jsonb_agg(otl.introduction_json(x) ORDER BY x.updated_at), '[]'::jsonb)
      FROM otl.member_introductions x
      WHERE x.team_id = t AND x.intro <> '' AND x.message_ts IS NOT NULL
    );
  END IF;

  IF op = 'prepare' THEN
    IF coalesce(token, '') = ''
      OR coalesce(p->>'intro', '') = ''
      OR char_length(p->>'intro') > 180
      OR p->>'intro' ~ E'[\r\n]'
      OR (p->>'linkedin' IS NOT NULL AND p->>'linkedin' !~ '^https://([A-Za-z0-9-]+\.)*linkedin\.com/in/[^/?#]+/?$')
    THEN RAISE EXCEPTION 'invalid introduction'; END IF;
    expected := (p->>'expectedRevision')::integer;
    INSERT INTO otl.member_introductions(team_id, user_id) VALUES(t, u) ON CONFLICT DO NOTHING;
    SELECT * INTO i FROM otl.member_introductions WHERE team_id = t AND user_id = u FOR UPDATE;
    IF i.revision <> expected OR i.pending_token IS NOT NULL THEN RETURN 'null'::jsonb; END IF;
    UPDATE otl.member_introductions
      SET pending_token = token,
          pending_intro = p->>'intro',
          pending_linkedin = nullif(p->>'linkedin', ''),
          pending_revision = revision + 1,
          updated_at = now()
      WHERE team_id = t AND user_id = u;
    RETURN otl.introduction_json(i);
  END IF;

  IF op = 'finish' THEN
    IF coalesce(token, '') = '' OR coalesce(p->>'channelId', '') = ''
      OR coalesce(p->>'messageTs', '') !~ '^[0-9]+\.[0-9]{6}$'
    THEN RAISE EXCEPTION 'invalid delivery'; END IF;
    UPDATE otl.member_introductions
      SET intro = pending_intro,
          linkedin = pending_linkedin,
          revision = pending_revision,
          channel_id = p->>'channelId',
          message_ts = p->>'messageTs',
          pending_token = NULL,
          pending_intro = NULL,
          pending_linkedin = NULL,
          pending_revision = NULL,
          updated_at = now()
      WHERE team_id = t AND user_id = u AND pending_token = token;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RETURN 'null'::jsonb; END IF;
    SELECT * INTO i FROM otl.member_introductions WHERE team_id = t AND user_id = u;
    RETURN otl.introduction_json(i);
  END IF;

  IF op = 'abort' THEN
    UPDATE otl.member_introductions
      SET pending_token = NULL,
          pending_intro = NULL,
          pending_linkedin = NULL,
          pending_revision = NULL,
          updated_at = now()
      WHERE team_id = t AND user_id = u AND pending_token = token;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN to_jsonb(changed = 1);
  END IF;

  RAISE EXCEPTION 'invalid introduction operation';
END;
$$;

INSERT INTO otl.schema_migrations(version)
VALUES ('011-member-introductions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
