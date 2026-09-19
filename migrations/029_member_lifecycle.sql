BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:member-lifecycle:029',0));

CREATE TABLE otl.member_lifecycles (
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','grace','dormant')),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  rollout_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_transition_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  grace_started_at timestamptz,
  grace_deadline date,
  extension_used boolean NOT NULL DEFAULT false,
  origin_inviter_user_id text,
  PRIMARY KEY(team_id,user_id),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.workspace_members(team_id,user_id),
  FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
  CHECK((state='grace')=(grace_started_at IS NOT NULL AND grace_deadline IS NOT NULL)),
  CHECK(state='grace' OR (grace_started_at IS NULL AND grace_deadline IS NULL))
);

CREATE TABLE otl.grass_seasons (
  season_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  opened_at timestamptz NOT NULL,
  opened_on date NOT NULL,
  opened_reason text NOT NULL CHECK(opened_reason IN ('rollout','return','admin_restore')),
  closed_at timestamptz,
  closed_on date,
  closed_reason text CHECK(closed_reason IN ('grace_expired','voluntary_stop','admin_correction')),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.member_lifecycles(team_id,user_id),
  FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
  CHECK((closed_at IS NULL)=(closed_on IS NULL)),
  CHECK((closed_at IS NULL)=(closed_reason IS NULL)),
  CHECK(closed_on IS NULL OR closed_on>=opened_on)
);
CREATE UNIQUE INDEX grass_seasons_one_open
  ON otl.grass_seasons(team_id,user_id) WHERE closed_at IS NULL;

CREATE TABLE otl.lifecycle_service_days (
  team_id text NOT NULL,
  channel_id text NOT NULL,
  service_date date NOT NULL,
  closed_at timestamptz NOT NULL,
  goal_prompt_sent_at timestamptz,
  membership_observed_at timestamptz,
  eligible boolean NOT NULL,
  exclusion_reason text CHECK(exclusion_reason IN ('weekend','goal_prompt_missing','snapshot_missing')),
  PRIMARY KEY(team_id,channel_id,service_date),
  FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
  CHECK(eligible=(exclusion_reason IS NULL))
);

CREATE TABLE otl.member_lifecycle_days (
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  service_date date NOT NULL,
  eligible boolean NOT NULL,
  exclusion_reason text CHECK(exclusion_reason IN ('weekend','goal_prompt_missing','snapshot_missing','before_rollout')),
  signal_kind text CHECK(signal_kind IN ('goal','outcome','reflection','rest')),
  season_id bigint NOT NULL REFERENCES otl.grass_seasons(season_id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(team_id,user_id,service_date),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.member_lifecycles(team_id,user_id),
  FOREIGN KEY(team_id,channel_id,service_date)
    REFERENCES otl.lifecycle_service_days(team_id,channel_id,service_date),
  CHECK(eligible=(exclusion_reason IS NULL))
);

CREATE TABLE otl.member_lifecycle_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  event_key text NOT NULL CHECK(btrim(event_key)<>''),
  event_type text NOT NULL CHECK(event_type IN (
    'rollout_seeded','grace_started','grace_extended','grace_cancelled','season_closed','reactivated'
  )),
  from_state text CHECK(from_state IN ('active','grace','dormant')),
  to_state text NOT NULL CHECK(to_state IN ('active','grace','dormant')),
  effective_at timestamptz NOT NULL,
  service_date date,
  revision integer NOT NULL CHECK(revision>=0),
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{32}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(team_id,user_id,event_key),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.member_lifecycles(team_id,user_id),
  FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id)
);

CREATE FUNCTION otl.lifecycle_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  RAISE EXCEPTION 'lifecycle audit rows are immutable';
END $$;
CREATE TRIGGER lifecycle_events_immutable BEFORE UPDATE OR DELETE ON otl.member_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_immutable();
CREATE TRIGGER lifecycle_days_immutable BEFORE UPDATE OR DELETE ON otl.member_lifecycle_days
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_immutable();
CREATE TRIGGER lifecycle_service_days_immutable BEFORE UPDATE OR DELETE ON otl.lifecycle_service_days
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_immutable();

CREATE FUNCTION otl.lifecycle_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.rollout_at IS DISTINCT FROM OLD.rollout_at
    OR NEW.origin_inviter_user_id IS DISTINCT FROM OLD.origin_inviter_user_id
  THEN RAISE EXCEPTION 'lifecycle identity and inviter are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_identity_immutable BEFORE UPDATE ON otl.member_lifecycles
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_identity_immutable();

WITH humans AS (
  SELECT DISTINCT ON(cm.team_id,cm.user_id)
    cm.team_id,cm.channel_id,cm.user_id,transaction_timestamp() seeded_at
  FROM otl.workspace_channel_memberships cm
  JOIN otl.workspace_members m USING(team_id,user_id)
  JOIN otl.workspaces w USING(team_id)
  WHERE cm.is_current AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false)
    AND NOT coalesce(m.slack_deleted,false)
  ORDER BY cm.team_id,cm.user_id,(cm.channel_id=w.primary_goal_channel_id) DESC,cm.channel_id
), seeded AS (
  INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,rollout_at,last_transition_at)
    SELECT team_id,channel_id,user_id,seeded_at,seeded_at FROM humans
    RETURNING *
), seasons AS (
  INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
    SELECT team_id,channel_id,user_id,rollout_at,(rollout_at AT TIME ZONE 'Asia/Seoul')::date,'rollout'
    FROM seeded RETURNING team_id,user_id
)
INSERT INTO otl.member_lifecycle_events(
  team_id,channel_id,user_id,event_key,event_type,from_state,to_state,effective_at,revision,request_hash,result
)
SELECT l.team_id,l.channel_id,l.user_id,'rollout-seed','rollout_seeded',NULL,'active',l.rollout_at,0,
  md5(jsonb_build_object('rolloutAt',l.rollout_at)::text),
  jsonb_build_object('state','active','revision',0,'retroactiveCandidate',false)
FROM otl.member_lifecycles l JOIN seasons s USING(team_id,user_id);

CREATE FUNCTION otl.lifecycle_member_json(l otl.member_lifecycles) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
  SELECT jsonb_build_object(
    'teamId',l.team_id,'channelId',l.channel_id,'userId',l.user_id,'state',l.state,
    'revision',l.revision,'rolloutAt',l.rollout_at,'lastTransitionAt',l.last_transition_at,
    'graceStartedAt',l.grace_started_at,'graceDeadline',l.grace_deadline,
    'extensionUsed',l.extension_used,'seasonId',(
      SELECT season_id FROM otl.grass_seasons s
      WHERE s.team_id=l.team_id AND s.user_id=l.user_id AND s.closed_at IS NULL
    )
  )
$$;

CREATE FUNCTION otl.lifecycle_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId'; k text:=p->>'key';
  clock timestamptz; local_day date; target_day date; expected integer; request_hash text:=md5(p::text);
  l otl.member_lifecycles; existing otl.member_lifecycle_events; service otl.lifecycle_service_days;
  prompt_sent timestamptz; snapshot_at timestamptz; reason text; is_eligible boolean; season bigint;
  signal text; result jsonb; affected integer;
BEGIN
  IF coalesce(t,'')='' OR coalesce(c,'')='' OR (op<>'close_day' AND coalesce(u,'')='')
  THEN RAISE EXCEPTION 'lifecycle scope required'; END IF;
  IF op='get' THEN
    SELECT * INTO l FROM otl.member_lifecycles WHERE team_id=t AND channel_id=c AND user_id=u;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle member not found'; END IF;
    RETURN otl.lifecycle_member_json(l);
  END IF;
  IF op NOT IN ('close_day','signal','extend','expire') THEN RAISE EXCEPTION 'invalid lifecycle operation'; END IF;
  IF coalesce(p->>'now','')='' THEN RAISE EXCEPTION 'lifecycle clock required'; END IF;
  clock:=(p->>'now')::timestamptz;
  local_day:=(clock AT TIME ZONE 'Asia/Seoul')::date;

  IF op='close_day' THEN
    target_day:=(p->>'date')::date;
    IF clock < ((target_day+1)::timestamp AT TIME ZONE 'Asia/Seoul')
    THEN RAISE EXCEPTION 'service day is not closed'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,target_day)::text,29));
    SELECT * INTO service FROM otl.lifecycle_service_days
      WHERE team_id=t AND channel_id=c AND service_date=target_day;
    IF FOUND THEN
      RETURN jsonb_build_object('date',target_day,'eligible',service.eligible,
        'reason',service.exclusion_reason,'changed',false);
    END IF;
    SELECT max(updated_at) INTO prompt_sent FROM otl.community_records
      WHERE team_id=t AND channel_id=c AND kind='dispatch' AND status='sent'
        AND body->>'date'=target_day::text AND body->>'kind'='goal' AND updated_at<=clock;
    SELECT membership_observed_at INTO snapshot_at FROM otl.workspace_channels
      WHERE team_id=t AND channel_id=c;
    IF extract(isodow FROM target_day)>=6 THEN reason:='weekend';
    ELSIF prompt_sent IS NULL THEN reason:='goal_prompt_missing';
    ELSIF snapshot_at IS NULL OR (snapshot_at AT TIME ZONE 'Asia/Seoul')::date<>target_day
      OR snapshot_at>clock THEN reason:='snapshot_missing';
    END IF;
    is_eligible:=reason IS NULL;
    INSERT INTO otl.lifecycle_service_days(
      team_id,channel_id,service_date,closed_at,goal_prompt_sent_at,membership_observed_at,eligible,exclusion_reason
    ) VALUES(t,c,target_day,clock,prompt_sent,snapshot_at,is_eligible,reason);
    FOR l IN SELECT x.* FROM otl.member_lifecycles x
      JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
      JOIN otl.workspace_members wm USING(team_id,user_id)
      WHERE x.team_id=t AND x.channel_id=c AND cm.is_current
        AND NOT coalesce(wm.is_bot,false) AND NOT coalesce(wm.is_app_user,false)
        AND NOT coalesce(wm.slack_deleted,false) FOR UPDATE OF x
    LOOP
      SELECT s.season_id INTO season FROM otl.grass_seasons s
        WHERE s.team_id=t AND s.user_id=l.user_id AND s.closed_at IS NULL;
      IF season IS NULL THEN CONTINUE; END IF;
      SELECT CASE WHEN d.goal<>'' THEN 'goal'
        WHEN d.reflection<>'' THEN 'reflection' WHEN d.resting THEN 'rest'
        WHEN d.outcome<>'pending' THEN 'outcome' END INTO signal
      FROM otl.community_days d WHERE d.team_id=t AND d.channel_id=c
        AND d.user_id=l.user_id AND d.day=target_day;
      INSERT INTO otl.member_lifecycle_days(
        team_id,channel_id,user_id,service_date,eligible,exclusion_reason,signal_kind,season_id,recorded_at
      ) VALUES(t,c,l.user_id,target_day,
        is_eligible AND target_day>=(l.rollout_at AT TIME ZONE 'Asia/Seoul')::date,
        CASE WHEN target_day<(l.rollout_at AT TIME ZONE 'Asia/Seoul')::date THEN 'before_rollout' ELSE reason END,
        signal,season,clock);
      IF l.state='active' AND is_eligible AND signal IS NULL AND (
        SELECT count(*) FROM (
          SELECT d.signal_kind FROM otl.member_lifecycle_days d
          WHERE d.team_id=t AND d.user_id=l.user_id AND d.eligible AND d.service_date<=target_day
          ORDER BY d.service_date DESC LIMIT 7
        ) recent WHERE signal_kind IS NULL
      )=7 AND NOT EXISTS(
        SELECT 1 FROM (
          SELECT d.signal_kind FROM otl.member_lifecycle_days d
          WHERE d.team_id=t AND d.user_id=l.user_id AND d.eligible AND d.service_date<=target_day
          ORDER BY d.service_date DESC LIMIT 7
        ) recent WHERE signal_kind IS NOT NULL
      ) THEN
        UPDATE otl.member_lifecycles SET state='grace',revision=revision+1,last_transition_at=clock,
          grace_started_at=clock,grace_deadline=local_day+7,extension_used=false
          WHERE team_id=t AND user_id=l.user_id RETURNING * INTO l;
        result:=otl.lifecycle_member_json(l);
        INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
          from_state,to_state,effective_at,service_date,revision,request_hash,result)
        VALUES(t,c,l.user_id,'grace:'||target_day,'grace_started','active','grace',clock,
          target_day,l.revision,md5(jsonb_build_object('date',target_day)::text),result);
      END IF;
    END LOOP;
    RETURN jsonb_build_object('date',target_day,'eligible',is_eligible,'reason',reason,'changed',true);
  END IF;

  IF coalesce(k,'')='' OR p->>'expectedRevision' !~ '^[0-9]+$'
  THEN RAISE EXCEPTION 'lifecycle key and revision required'; END IF;
  expected:=(p->>'expectedRevision')::integer;
  SELECT * INTO existing FROM otl.member_lifecycle_events
    WHERE team_id=t AND user_id=u AND event_key=k;
  IF FOUND THEN
    IF existing.request_hash<>request_hash THEN RAISE EXCEPTION 'lifecycle idempotency collision'; END IF;
    RETURN existing.result;
  END IF;
  SELECT * INTO l FROM otl.member_lifecycles
    WHERE team_id=t AND channel_id=c AND user_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle member not found'; END IF;
  IF l.revision<>expected THEN RAISE EXCEPTION 'stale lifecycle revision'; END IF;
  IF clock<l.last_transition_at THEN RAISE EXCEPTION 'stale lifecycle clock'; END IF;

  IF op='extend' THEN
    IF l.state<>'grace' OR l.extension_used OR local_day>=l.grace_deadline
    THEN RAISE EXCEPTION 'grace extension denied'; END IF;
    UPDATE otl.member_lifecycles SET extension_used=true,grace_deadline=grace_deadline+7,
      revision=revision+1,last_transition_at=clock WHERE team_id=t AND user_id=u RETURNING * INTO l;
    result:=otl.lifecycle_member_json(l);
    INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
      from_state,to_state,effective_at,revision,request_hash,result)
    VALUES(t,c,u,k,'grace_extended','grace','grace',clock,l.revision,request_hash,result);
    RETURN result;
  END IF;

  IF op='expire' THEN
    IF l.state<>'grace' OR local_day<l.grace_deadline THEN RAISE EXCEPTION 'grace expiry denied'; END IF;
    UPDATE otl.member_lifecycles SET state='dormant',revision=revision+1,last_transition_at=clock,
      grace_started_at=NULL,grace_deadline=NULL WHERE team_id=t AND user_id=u RETURNING * INTO l;
    UPDATE otl.grass_seasons SET closed_at=clock,closed_on=local_day,closed_reason='grace_expired'
      WHERE team_id=t AND user_id=u AND closed_at IS NULL;
    result:=otl.lifecycle_member_json(l);
    INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
      from_state,to_state,effective_at,revision,request_hash,result)
    VALUES(t,c,u,k,'season_closed','grace','dormant',clock,l.revision,request_hash,result);
    RETURN result;
  END IF;

  target_day:=(p->>'date')::date;
  IF target_day<>local_day THEN RETURN otl.lifecycle_member_json(l); END IF;
  signal:=p->>'signal';
  IF signal NOT IN ('goal','outcome','reflection','rest') THEN RAISE EXCEPTION 'invalid lifecycle signal'; END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.community_days d WHERE d.team_id=t AND d.channel_id=c
    AND d.user_id=u AND d.day=target_day AND CASE signal
      WHEN 'goal' THEN d.goal<>'' WHEN 'outcome' THEN d.outcome<>'pending'
      WHEN 'reflection' THEN d.reflection<>'' WHEN 'rest' THEN d.resting END)
  THEN RAISE EXCEPTION 'stored lifecycle signal required'; END IF;
  IF l.state='active' THEN RETURN otl.lifecycle_member_json(l); END IF;
  IF l.state='dormant' AND signal<>'goal' THEN RAISE EXCEPTION 'new current goal required to return'; END IF;
  IF l.state='grace' THEN
    IF local_day>=l.grace_deadline THEN RAISE EXCEPTION 'grace expired'; END IF;
    UPDATE otl.member_lifecycles SET state='active',revision=revision+1,last_transition_at=clock,
      grace_started_at=NULL,grace_deadline=NULL WHERE team_id=t AND user_id=u RETURNING * INTO l;
    result:=otl.lifecycle_member_json(l);
    INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
      from_state,to_state,effective_at,service_date,revision,request_hash,result)
    VALUES(t,c,u,k,'grace_cancelled','grace','active',clock,target_day,l.revision,request_hash,result);
    RETURN result;
  END IF;
  UPDATE otl.member_lifecycles SET state='active',revision=revision+1,last_transition_at=clock,
    extension_used=false WHERE team_id=t AND user_id=u RETURNING * INTO l;
  INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
    VALUES(t,c,u,clock,local_day,'return') RETURNING season_id INTO season;
  result:=otl.lifecycle_member_json(l);
  INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
    from_state,to_state,effective_at,service_date,revision,request_hash,result)
  VALUES(t,c,u,k,'reactivated','dormant','active',clock,target_day,l.revision,request_hash,result);
  RETURN result;
END $$;

REVOKE ALL ON TABLE otl.member_lifecycles,otl.grass_seasons,otl.lifecycle_service_days,
  otl.member_lifecycle_days,otl.member_lifecycle_events FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.lifecycle_member_json(otl.member_lifecycles) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.lifecycle_execute(text,jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('029-member-lifecycle');
COMMIT;
