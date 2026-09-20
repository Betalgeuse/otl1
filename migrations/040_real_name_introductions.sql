BEGIN;

ALTER TABLE otl.member_introductions
  ADD COLUMN confirmed_name text,
  ADD COLUMN pending_confirmed_name text,
  ADD CONSTRAINT member_introductions_confirmed_name_check
    CHECK (confirmed_name IS NULL OR (char_length(confirmed_name) BETWEEN 1 AND 40 AND confirmed_name !~ E'[\r\n]'));

-- Existing introductions retain NULL until the member saves a modal or an explicitly authorized backfill runs.
CREATE OR REPLACE FUNCTION otl.introduction_json(i otl.member_introductions)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'teamId', i.team_id, 'userId', i.user_id,
    'confirmedName', i.confirmed_name,
    'intro', i.intro, 'linkedin', i.linkedin, 'details', i.details,
    'channelId', i.channel_id, 'messageTs', i.message_ts, 'revision', i.revision
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
      OR coalesce(btrim(p->>'confirmedName'), '') = ''
      OR char_length(btrim(p->>'confirmedName')) > 40
      OR p->>'confirmedName' ~ E'[\r\n]'
      OR coalesce(p->>'intro', '') = ''
      OR char_length(p->>'intro') > 180
      OR (p->>'linkedin' IS NOT NULL AND p->>'linkedin' !~ '^https://([A-Za-z0-9-]+\.)*linkedin\.com/in/[^/?#]+/?$')
      OR (p->>'details' IS NOT NULL AND (char_length(p->>'details') > 300 OR p->>'details' ~ E'[\r\n]'))
    THEN RAISE EXCEPTION 'invalid introduction'; END IF;
    expected := (p->>'expectedRevision')::integer;
    INSERT INTO otl.member_introductions(team_id, user_id) VALUES(t, u) ON CONFLICT DO NOTHING;
    SELECT * INTO i FROM otl.member_introductions WHERE team_id = t AND user_id = u FOR UPDATE;
    IF i.revision <> expected OR i.pending_token IS NOT NULL THEN RETURN 'null'::jsonb; END IF;
    UPDATE otl.member_introductions
      SET pending_token = token,
          pending_confirmed_name = btrim(p->>'confirmedName'),
          pending_intro = p->>'intro',
          pending_linkedin = nullif(p->>'linkedin', ''),
          pending_details = nullif(p->>'details', ''),
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
      SET confirmed_name = pending_confirmed_name,
          intro = pending_intro,
          linkedin = pending_linkedin,
          details = pending_details,
          revision = pending_revision,
          channel_id = p->>'channelId',
          message_ts = p->>'messageTs',
          pending_token = NULL,
          pending_confirmed_name = NULL,
          pending_intro = NULL,
          pending_linkedin = NULL,
          pending_details = NULL,
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
          pending_confirmed_name = NULL,
          pending_intro = NULL,
          pending_linkedin = NULL,
          pending_details = NULL,
          pending_revision = NULL,
          updated_at = now()
      WHERE team_id = t AND user_id = u AND pending_token = token;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN to_jsonb(changed = 1);
  END IF;

  RAISE EXCEPTION 'invalid introduction operation';
END;
$$;

-- The public name is released only after the same capacity and active-link resolver accepts the token.
CREATE FUNCTION otl.referral_resolve_named(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE resolved jsonb; owner_id text; public_name text;
BEGIN
  resolved:=otl.referral_runtime_execute('resolve',p);
  IF resolved->>'available'<>'true' THEN RETURN jsonb_build_object('available',false); END IF;
  SELECT referrer_user_id INTO owner_id FROM otl.member_referral_links
    WHERE team_id=p->>'teamId' AND token_digest=p->>'tokenDigest' AND status='active';
  SELECT confirmed_name INTO public_name FROM otl.member_introductions
    WHERE team_id=p->>'teamId' AND user_id=owner_id AND message_ts IS NOT NULL;
  RETURN jsonb_build_object('available',true,'inviterName',public_name);
END $$;
REVOKE ALL ON FUNCTION otl.referral_resolve_named(jsonb) FROM PUBLIC,otl_referral_runtime,otl_referral_admin;
GRANT EXECUTE ON FUNCTION otl.referral_resolve_named(jsonb) TO otl_referral_runtime;

INSERT INTO otl.schema_migrations(version) VALUES ('040-real-name-introductions');
COMMIT;
