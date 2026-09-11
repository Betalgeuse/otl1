CREATE OR REPLACE FUNCTION otl.execute(
  p_team text, p_user text, p_today date, p_action text, p_date date,
  p_text text, p_palette jsonb, p_event_time numeric
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE
  primary_channel text;
  current_day otl.community_days;
BEGIN
  IF p_team IS NULL OR p_team = '' OR p_user IS NULL OR p_user = ''
     OR p_today IS NULL OR p_date IS NULL OR p_action IS NULL
     OR p_action NOT IN ('get', 'write', 'complete', 'reopen', 'palette')
     OR p_event_time IS NULL OR p_event_time < 0
     OR p_event_time::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Invalid command' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'write' AND (p_date <> p_today OR p_text IS NULL
     OR length(btrim(p_text)) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'Goals must be written for today with 1 to 500 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_action IN ('complete', 'reopen') AND p_date > p_today THEN
    RAISE EXCEPTION 'Future goals cannot be changed' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'palette' AND (
     p_palette IS NULL OR jsonb_typeof(p_palette) <> 'object'
     OR (p_palette ->> 'empty') IS NULL OR (p_palette ->> 'written') IS NULL
     OR (p_palette ->> 'complete') IS NULL
     OR (p_palette ->> 'empty') !~ '^#[0-9A-Fa-f]{6}$'
     OR (p_palette ->> 'written') !~ '^#[0-9A-Fa-f]{6}$'
     OR (p_palette ->> 'complete') !~ '^#[0-9A-Fa-f]{6}$') THEN
    RAISE EXCEPTION 'Palette requires three HEX colors' USING ERRCODE = '22023';
  END IF;

  IF p_action <> 'get' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_team,p_user)::text,1));
  END IF;
  SELECT primary_goal_channel_id INTO primary_channel
    FROM otl.workspaces WHERE team_id = p_team;
  IF p_action IN ('write', 'complete', 'reopen') AND primary_channel IS NULL THEN
    RAISE EXCEPTION 'Primary goal channel required' USING ERRCODE = '22023';
  END IF;

  IF p_action <> 'get' THEN
    INSERT INTO otl.profiles (team_id, user_id) VALUES (p_team, p_user)
      ON CONFLICT DO NOTHING;
    PERFORM 1 FROM otl.profiles
      WHERE team_id = p_team AND user_id = p_user FOR UPDATE;
  END IF;

  IF p_action = 'palette' THEN
    UPDATE otl.profiles SET empty_color = p_palette ->> 'empty',
      written_color = p_palette ->> 'written', complete_color = p_palette ->> 'complete',
      palette_revision = p_event_time
      WHERE team_id = p_team AND user_id = p_user AND palette_revision < p_event_time;
  ELSIF p_action IN ('write', 'complete', 'reopen') THEN
    SELECT * INTO current_day FROM otl.community_days
      WHERE team_id = p_team AND channel_id = primary_channel
        AND user_id = p_user AND day = p_date;
    IF p_event_time > coalesce(current_day.last_event_time, -1)
       AND ((p_action = 'write' AND coalesce(current_day.outcome, 'pending') <> 'complete')
         OR (p_action IN ('complete', 'reopen') AND coalesce(current_day.goal, '') <> '')) THEN
      PERFORM otl.community_execute('change', jsonb_build_object(
        'teamId', p_team, 'channelId', primary_channel, 'userId', p_user,
        'date', p_date, 'key', 'legacy:' || p_action || ':' || p_event_time::text,
        'action', CASE WHEN p_action = 'write' THEN 'goal' ELSE p_action END,
        'text', btrim(p_text), 'expectedRevision', coalesce(current_day.revision, 0),
        'legacyEventTime', p_event_time, 'preserveOutcome', p_action = 'write'
      ));
      IF p_action = 'write' THEN
        UPDATE otl.profiles SET start_date = least(coalesce(start_date, p_date), p_date)
          WHERE team_id = p_team AND user_id = p_user;
      END IF;
    END IF;
  END IF;

  RETURN (SELECT jsonb_build_object(
    'startDate', coalesce(least(profile.start_date, history.first_day), p_today)::text,
    'palette', jsonb_build_object(
      'empty', coalesce(profile.empty_color, '#EBEDF0'),
      'written', coalesce(profile.written_color, '#9BE9A8'),
      'complete', coalesce(profile.complete_color, '#216E39')),
    'goals', history.goals
  ) FROM (VALUES (1)) AS anchor(id)
    LEFT JOIN otl.profiles profile ON profile.team_id = p_team AND profile.user_id = p_user
    CROSS JOIN LATERAL (
      SELECT min(day) AS first_day,
        coalesce(jsonb_agg(jsonb_build_object(
          'date', day::text, 'text', goal, 'completed', outcome = 'complete'
        ) ORDER BY day), '[]'::jsonb) AS goals
      FROM otl.community_days
      WHERE team_id = p_team AND channel_id = primary_channel
        AND user_id = p_user AND goal <> ''
    ) history);
END;
$$;
