BEGIN;
CREATE OR REPLACE FUNCTION otl.execute(
  p_team text, p_user text, p_today date, p_action text, p_date date,
  p_text text, p_palette jsonb, p_event_time numeric
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM otl.memberships
    WHERE workspace_id = p_team AND user_id = p_user) THEN
    RAISE EXCEPTION 'Membership required' USING ERRCODE = '42501';
  END IF;

  IF p_team IS NULL OR p_team = '' OR p_user IS NULL OR p_user = ''
     OR p_today IS NULL OR p_date IS NULL OR p_action IS NULL
     OR p_action NOT IN ('get', 'write', 'complete', 'reopen', 'palette')
     OR p_event_time IS NULL OR p_event_time < 0
     OR p_event_time::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Invalid command' USING ERRCODE = '22023';
  END IF;

  IF p_action <> 'get' THEN
    INSERT INTO otl.profiles (team_id, user_id) VALUES (p_team, p_user)
      ON CONFLICT DO NOTHING;
    PERFORM 1 FROM otl.profiles
      WHERE team_id = p_team AND user_id = p_user FOR UPDATE;
  END IF;

  CASE p_action
    WHEN 'write' THEN
      IF p_date <> p_today OR p_text IS NULL
         OR length(btrim(p_text)) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Goals must be written for today with 1 to 500 characters'
          USING ERRCODE = '22023';
      END IF;
      UPDATE otl.profiles SET start_date = p_today
        WHERE team_id = p_team AND user_id = p_user AND start_date IS NULL;
      INSERT INTO otl.goals (team_id, user_id, goal_date, goal_text, revision)
        VALUES (p_team, p_user, p_date, btrim(p_text), p_event_time)
        ON CONFLICT (team_id, user_id, goal_date) DO UPDATE
          SET goal_text = EXCLUDED.goal_text, revision = EXCLUDED.revision
          WHERE NOT otl.goals.completed AND otl.goals.revision < EXCLUDED.revision;
    WHEN 'complete', 'reopen' THEN
      IF p_date > p_today THEN
        RAISE EXCEPTION 'Future goals cannot be changed' USING ERRCODE = '22023';
      END IF;
      UPDATE otl.goals SET completed = (p_action = 'complete'), revision = p_event_time
        WHERE team_id = p_team AND user_id = p_user AND goal_date = p_date
          AND revision < p_event_time;
    WHEN 'palette' THEN
      IF p_palette IS NULL OR jsonb_typeof(p_palette) <> 'object'
         OR (p_palette ->> 'empty') IS NULL OR (p_palette ->> 'written') IS NULL
         OR (p_palette ->> 'complete') IS NULL
         OR (p_palette ->> 'empty') !~ '^#[0-9A-Fa-f]{6}$'
         OR (p_palette ->> 'written') !~ '^#[0-9A-Fa-f]{6}$'
         OR (p_palette ->> 'complete') !~ '^#[0-9A-Fa-f]{6}$' THEN
        RAISE EXCEPTION 'Palette requires three HEX colors' USING ERRCODE = '22023';
      END IF;
      UPDATE otl.profiles SET empty_color = p_palette ->> 'empty',
        written_color = p_palette ->> 'written', complete_color = p_palette ->> 'complete',
        palette_revision = p_event_time
        WHERE team_id = p_team AND user_id = p_user AND palette_revision < p_event_time;
    WHEN 'get' THEN NULL;
  END CASE;

  RETURN (SELECT jsonb_build_object(
    'startDate', coalesce(profile.start_date, p_today)::text,
    'palette', jsonb_build_object(
      'empty', coalesce(profile.empty_color, '#EBEDF0'),
      'written', coalesce(profile.written_color, '#9BE9A8'),
      'complete', coalesce(profile.complete_color, '#216E39')),
    'goals', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'date', goal_date::text, 'text', goal_text, 'completed', completed) ORDER BY goal_date)
      FROM otl.goals WHERE team_id = p_team AND user_id = p_user), '[]'::jsonb)
  ) FROM (VALUES (1)) AS anchor(id) LEFT JOIN otl.profiles profile
    ON profile.team_id = p_team AND profile.user_id = p_user);
END;
$$;
COMMIT;
