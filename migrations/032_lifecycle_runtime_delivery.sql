BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:lifecycle-runtime-delivery:032',0));

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_lifecycle_runtime') THEN
    CREATE ROLE otl_lifecycle_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='otl_lifecycle_admin') THEN
    CREATE ROLE otl_lifecycle_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
ALTER ROLE otl_lifecycle_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE otl_lifecycle_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON SCHEMA otl FROM otl_lifecycle_runtime,otl_lifecycle_admin;
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM otl_lifecycle_runtime,otl_lifecycle_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM otl_lifecycle_runtime,otl_lifecycle_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otl FROM otl_lifecycle_runtime,otl_lifecycle_admin;
GRANT USAGE ON SCHEMA otl TO otl_lifecycle_runtime,otl_lifecycle_admin;

CREATE TABLE otl.lifecycle_runtime_evaluations (
  evaluation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  service_date date NOT NULL,
  mode text NOT NULL CHECK(mode IN ('shadow','enforce')),
  eligible boolean NOT NULL,
  exclusion_reason text CHECK(exclusion_reason IN ('weekend','goal_prompt_missing','snapshot_missing','before_rollout')),
  signal_kind text CHECK(signal_kind IN ('goal','outcome','reflection','rest')),
  candidate boolean NOT NULL,
  explanation jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL,
  UNIQUE(team_id,user_id,service_date,mode),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.member_lifecycles(team_id,user_id),
  FOREIGN KEY(team_id,channel_id) REFERENCES otl.workspace_channels(team_id,channel_id),
  CHECK(eligible=(exclusion_reason IS NULL))
);

CREATE TABLE otl.lifecycle_runtime_actions (
  action_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  action_key text NOT NULL,
  action_type text NOT NULL CHECK(action_type IN ('lifecycle_extend','lifecycle_review','lifecycle_stop','lifecycle_restore_error')),
  actor_class text NOT NULL CHECK(actor_class IN ('member','admin','runtime')),
  expected_revision integer NOT NULL CHECK(expected_revision>=0),
  resulting_revision integer NOT NULL CHECK(resulting_revision>=0),
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{32}$'),
  evidence_key text,
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE(team_id,user_id,action_key),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.member_lifecycles(team_id,user_id)
);

CREATE TABLE otl.lifecycle_notice_outbox (
  notice_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  effect_key text NOT NULL,
  notice_kind text NOT NULL CHECK(notice_kind IN ('grace_start','three_days','one_day','extension','closure','return')),
  lifecycle_revision integer NOT NULL CHECK(lifecycle_revision>=0),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','sent','failed','dead','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_token text,
  lease_expires_at timestamptz,
  retry_at timestamptz,
  dm_channel_id text,
  message_ts text,
  payload jsonb NOT NULL,
  payload_digest text,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(team_id,user_id,effect_key),
  FOREIGN KEY(team_id,user_id) REFERENCES otl.member_lifecycles(team_id,user_id),
  CHECK((status='claimed')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(status='sent' OR message_ts IS NULL)
);
CREATE INDEX lifecycle_notice_due ON otl.lifecycle_notice_outbox(team_id,scheduled_at,retry_at)
  WHERE status IN ('pending','failed','claimed');

CREATE FUNCTION otl.lifecycle_runtime_audit_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN RAISE EXCEPTION 'lifecycle runtime audit rows are immutable'; END $$;
CREATE TRIGGER lifecycle_runtime_evaluations_immutable BEFORE UPDATE OR DELETE ON otl.lifecycle_runtime_evaluations
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_runtime_audit_immutable();
CREATE TRIGGER lifecycle_runtime_actions_immutable BEFORE UPDATE OR DELETE ON otl.lifecycle_runtime_actions
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_runtime_audit_immutable();

CREATE FUNCTION otl.lifecycle_enqueue_notice(
  l otl.member_lifecycles, effect text, kind text, due timestamptz, now_at timestamptz
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  INSERT INTO otl.lifecycle_notice_outbox(team_id,channel_id,user_id,effect_key,notice_kind,
    lifecycle_revision,scheduled_at,payload,created_at,updated_at)
  VALUES(l.team_id,l.channel_id,l.user_id,effect,kind,l.revision,due,
    jsonb_build_object('deadline',l.grace_deadline,'revision',l.revision),now_at,now_at)
  ON CONFLICT(team_id,user_id,effect_key) DO NOTHING;
END $$;

CREATE FUNCTION otl.lifecycle_runtime_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
  now_at timestamptz; local_day date; target_day date; eval_mode text:=p->>'mode';
  batch integer:=least(greatest(coalesce((p->>'limit')::integer,10),1),50);
  processed integer:=0; candidates integer:=0; transitions integer:=0; remaining integer:=0;
  prompt_at timestamptz; snapshot_at timestamptz; global_reason text; signal text;
  prior_count integer; prior_signal_count integer; is_candidate boolean; l otl.member_lifecycles;
  explanation jsonb; counted_dates jsonb; excluded_dates jsonb;
  due_at timestamptz; claim jsonb; lease text:=p->>'leaseToken';
  expected integer; existing otl.lifecycle_runtime_actions; request_hash text:=md5(p::text);
  action_result jsonb; old_state text; rec record;
BEGIN
  IF coalesce(t,'')='' THEN RAISE EXCEPTION 'lifecycle runtime scope required'; END IF;
  IF op='next_due' THEN
    SELECT min(CASE WHEN status='claimed' THEN lease_expires_at
      WHEN status='failed' THEN greatest(scheduled_at,retry_at) ELSE scheduled_at END)
      INTO due_at FROM otl.lifecycle_notice_outbox
      WHERE team_id=t AND status IN ('pending','failed','claimed') AND attempts<3;
    RETURN to_jsonb(due_at);
  END IF;
  IF coalesce(p->>'now','')='' THEN RAISE EXCEPTION 'lifecycle runtime clock required'; END IF;
  now_at:=(p->>'now')::timestamptz;
  local_day:=(now_at AT TIME ZONE 'Asia/Seoul')::date;

  IF op='evaluate_batch' THEN
    IF coalesce(c,'')='' OR eval_mode NOT IN ('disabled','shadow','enforce') THEN
      RAISE EXCEPTION 'invalid lifecycle evaluation';
    END IF;
    IF eval_mode='disabled' THEN
      RETURN jsonb_build_object('processed',0,'candidates',0,'transitions',0,'possiblyMore',false,'nextDue',NULL);
    END IF;
    target_day:=coalesce((p->>'date')::date,local_day-1);
    IF now_at<((target_day+1)::timestamp AT TIME ZONE 'Asia/Seoul') THEN
      RAISE EXCEPTION 'service day is not closed';
    END IF;
    SELECT max(updated_at) INTO prompt_at FROM otl.community_records
      WHERE team_id=t AND channel_id=c AND kind='dispatch' AND status='sent'
        AND body->>'date'=target_day::text AND body->>'kind'='goal' AND updated_at<=now_at;
    SELECT complete_membership_observed_at INTO snapshot_at FROM otl.workspace_channels
      WHERE team_id=t AND channel_id=c;
    IF extract(isodow FROM target_day)>=6 THEN global_reason:='weekend';
    ELSIF prompt_at IS NULL THEN global_reason:='goal_prompt_missing';
    ELSIF snapshot_at IS NULL OR (snapshot_at AT TIME ZONE 'Asia/Seoul')::date<>target_day OR snapshot_at>now_at
      THEN global_reason:='snapshot_missing';
    END IF;
    FOR l IN SELECT x.* FROM otl.member_lifecycles x
      JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
      JOIN otl.workspace_members wm USING(team_id,user_id)
      WHERE x.team_id=t AND x.channel_id=c AND cm.is_current
        AND NOT coalesce(wm.is_bot,false) AND NOT coalesce(wm.is_app_user,false)
        AND NOT coalesce(wm.slack_deleted,false)
        AND NOT EXISTS(SELECT 1 FROM otl.lifecycle_runtime_evaluations e
          WHERE e.team_id=t AND e.user_id=x.user_id AND e.service_date=target_day AND e.mode=eval_mode)
      ORDER BY x.user_id LIMIT batch FOR UPDATE OF x SKIP LOCKED
    LOOP
      signal:=NULL;
      SELECT CASE WHEN d.goal<>'' THEN 'goal' WHEN d.reflection<>'' THEN 'reflection'
        WHEN d.resting THEN 'rest' WHEN d.outcome<>'pending' THEN 'outcome' END INTO signal
      FROM otl.community_days d WHERE d.team_id=t AND d.channel_id=c
        AND d.user_id=l.user_id AND d.day=target_day;
      SELECT count(*),count(*) FILTER(WHERE recent.signal_kind IS NOT NULL)
        INTO prior_count,prior_signal_count FROM (
          SELECT DISTINCT ON(e.service_date) e.service_date,e.signal_kind
          FROM otl.lifecycle_runtime_evaluations e
          WHERE e.team_id=t AND e.user_id=l.user_id AND e.eligible AND e.service_date<target_day
          ORDER BY e.service_date DESC,e.evaluated_at DESC LIMIT 6
        ) recent;
      SELECT coalesce(jsonb_agg(service_date ORDER BY service_date),'[]'::jsonb) INTO counted_dates
      FROM (SELECT DISTINCT ON(e.service_date) e.service_date
        FROM otl.lifecycle_runtime_evaluations e
        WHERE e.team_id=t AND e.user_id=l.user_id AND e.eligible AND e.service_date<target_day
        ORDER BY e.service_date DESC,e.evaluated_at DESC LIMIT 6) counted;
      IF global_reason IS NULL THEN counted_dates:=counted_dates||to_jsonb(target_day); END IF;
      SELECT coalesce(jsonb_agg(jsonb_build_object('date',service_date,'reason',exclusion_reason)
        ORDER BY service_date),'[]'::jsonb) INTO excluded_dates
      FROM (SELECT DISTINCT ON(e.service_date) e.service_date,e.exclusion_reason
        FROM otl.lifecycle_runtime_evaluations e
        WHERE e.team_id=t AND e.user_id=l.user_id AND NOT e.eligible AND e.service_date<target_day
        ORDER BY e.service_date DESC,e.evaluated_at DESC LIMIT 14) excluded;
      IF global_reason IS NOT NULL THEN excluded_dates:=excluded_dates||jsonb_build_array(
        jsonb_build_object('date',target_day,'reason',global_reason)); END IF;
      is_candidate:=l.state='active' AND global_reason IS NULL
        AND target_day>=(l.rollout_at AT TIME ZONE 'Asia/Seoul')::date
        AND signal IS NULL AND prior_count=6 AND prior_signal_count=0;
      explanation:=jsonb_build_object('code',CASE WHEN is_candidate THEN 'seven_inactive_service_days'
        WHEN global_reason IS NOT NULL THEN global_reason WHEN signal IS NOT NULL THEN 'participation_signal'
        WHEN l.state<>'active' THEN 'not_active' ELSE 'window_incomplete' END,
        'serviceDate',target_day,'eligible',global_reason IS NULL,'priorEligibleDays',prior_count,
        'countedDates',counted_dates,'excludedDates',excluded_dates);
      INSERT INTO otl.lifecycle_runtime_evaluations(team_id,channel_id,user_id,service_date,mode,
        eligible,exclusion_reason,signal_kind,candidate,explanation,evaluated_at)
      VALUES(t,c,l.user_id,target_day,eval_mode,
        global_reason IS NULL AND target_day>=(l.rollout_at AT TIME ZONE 'Asia/Seoul')::date,
        CASE WHEN target_day<(l.rollout_at AT TIME ZONE 'Asia/Seoul')::date THEN 'before_rollout' ELSE global_reason END,
        signal,is_candidate,explanation,now_at);
      processed:=processed+1;
      IF is_candidate THEN candidates:=candidates+1; END IF;
      IF eval_mode='enforce' AND is_candidate THEN
        UPDATE otl.member_lifecycles SET state='grace',revision=revision+1,last_transition_at=now_at,
          grace_started_at=now_at,grace_deadline=local_day+7,extension_used=false
          WHERE team_id=t AND user_id=l.user_id RETURNING * INTO l;
        action_result:=otl.lifecycle_member_json(l);
        INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
          from_state,to_state,effective_at,service_date,revision,request_hash,result)
        VALUES(t,c,l.user_id,'runtime-grace:'||target_day,'grace_started','active','grace',now_at,
          target_day,l.revision,md5(explanation::text),action_result) ON CONFLICT DO NOTHING;
        PERFORM otl.lifecycle_enqueue_notice(l,'grace:'||l.revision||':start','grace_start',now_at,now_at);
        PERFORM otl.lifecycle_enqueue_notice(l,'grace:'||l.revision||':3d','three_days',
          ((l.grace_deadline-3)::timestamp AT TIME ZONE 'Asia/Seoul'),now_at);
        PERFORM otl.lifecycle_enqueue_notice(l,'grace:'||l.revision||':1d','one_day',
          ((l.grace_deadline-1)::timestamp AT TIME ZONE 'Asia/Seoul'),now_at);
        transitions:=transitions+1;
      END IF;
    END LOOP;
    SELECT count(*) INTO remaining FROM otl.member_lifecycles x
      JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
      JOIN otl.workspace_members wm USING(team_id,user_id)
      WHERE x.team_id=t AND x.channel_id=c AND cm.is_current
        AND NOT coalesce(wm.is_bot,false) AND NOT coalesce(wm.is_app_user,false)
        AND NOT coalesce(wm.slack_deleted,false)
        AND NOT EXISTS(SELECT 1 FROM otl.lifecycle_runtime_evaluations e
          WHERE e.team_id=t AND e.user_id=x.user_id AND e.service_date=target_day AND e.mode=eval_mode);
    SELECT min(CASE WHEN status='claimed' THEN lease_expires_at
      WHEN status='failed' THEN greatest(scheduled_at,retry_at) ELSE scheduled_at END)
      INTO due_at FROM otl.lifecycle_notice_outbox
      WHERE team_id=t AND status IN ('pending','failed','claimed') AND attempts<3;
    RETURN jsonb_build_object('processed',processed,'candidates',candidates,'transitions',transitions,
      'possiblyMore',remaining>0,'nextDue',CASE WHEN remaining>0 THEN now_at+interval '1 second' ELSE due_at END);
  END IF;

  IF op='reconcile' THEN
    FOR l IN SELECT * FROM otl.member_lifecycles WHERE team_id=t AND state='grace'
      AND grace_deadline<=local_day ORDER BY user_id LIMIT batch FOR UPDATE SKIP LOCKED
    LOOP
      target_day:=l.grace_deadline;
      UPDATE otl.member_lifecycles SET state='dormant',revision=revision+1,last_transition_at=now_at,
        grace_started_at=NULL,grace_deadline=NULL WHERE team_id=t AND user_id=l.user_id RETURNING * INTO l;
      UPDATE otl.grass_seasons SET closed_at=now_at,closed_on=local_day,closed_reason='grace_expired'
        WHERE team_id=t AND user_id=l.user_id AND closed_at IS NULL;
      action_result:=otl.lifecycle_member_json(l);
      INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
        from_state,to_state,effective_at,service_date,revision,request_hash,result)
      VALUES(t,l.channel_id,l.user_id,'runtime-expire:'||target_day,'season_closed','grace','dormant',
        now_at,target_day,l.revision,md5(jsonb_build_object('deadline',target_day)::text),action_result)
      ON CONFLICT DO NOTHING;
      PERFORM otl.lifecycle_enqueue_notice(l,'closure:'||l.revision,'closure',now_at,now_at);
      UPDATE otl.lifecycle_notice_outbox SET status='cancelled',updated_at=now_at,lease_token=NULL,lease_expires_at=NULL
        WHERE team_id=t AND user_id=l.user_id AND status IN ('pending','failed')
          AND notice_kind IN ('three_days','one_day');
      processed:=processed+1;
    END LOOP;
    FOR rec IN SELECT DISTINCT e.team_id,e.user_id FROM otl.member_lifecycle_events e
      WHERE e.team_id=t AND e.event_type='grace_cancelled'
        AND EXISTS(SELECT 1 FROM otl.lifecycle_notice_outbox n
          WHERE n.team_id=e.team_id AND n.user_id=e.user_id AND n.status IN ('pending','failed')
            AND n.notice_kind IN ('three_days','one_day'))
      ORDER BY e.user_id LIMIT greatest(batch-processed,0)
    LOOP
      UPDATE otl.lifecycle_notice_outbox SET status='cancelled',updated_at=now_at,
        lease_token=NULL,lease_expires_at=NULL
        WHERE team_id=rec.team_id AND user_id=rec.user_id AND status IN ('pending','failed')
          AND notice_kind IN ('three_days','one_day');
      processed:=processed+1;
    END LOOP;
    FOR rec IN SELECT e.team_id,e.channel_id,e.user_id,e.revision,e.event_key
      FROM otl.member_lifecycle_events e
      WHERE e.team_id=t AND e.event_type='reactivated'
        AND NOT EXISTS(SELECT 1 FROM otl.lifecycle_notice_outbox n
          WHERE n.team_id=e.team_id AND n.user_id=e.user_id AND n.effect_key='return:'||e.revision)
      ORDER BY e.event_id LIMIT greatest(batch-processed,0)
    LOOP
      SELECT * INTO l FROM otl.member_lifecycles WHERE team_id=rec.team_id AND user_id=rec.user_id;
      PERFORM otl.lifecycle_enqueue_notice(l,'return:'||rec.revision,'return',now_at,now_at);
      processed:=processed+1;
    END LOOP;
    SELECT min(CASE WHEN status='claimed' THEN lease_expires_at
      WHEN status='failed' THEN greatest(scheduled_at,retry_at) ELSE scheduled_at END)
      INTO due_at FROM otl.lifecycle_notice_outbox
      WHERE team_id=t AND status IN ('pending','failed','claimed') AND attempts<3;
    RETURN jsonb_build_object('processed',processed,'possiblyMore',processed=batch,'nextDue',due_at);
  END IF;

  IF op='claim_notices' THEN
    IF coalesce(lease,'')='' THEN RAISE EXCEPTION 'notice lease required'; END IF;
    UPDATE otl.lifecycle_notice_outbox SET status='failed',lease_token=NULL,lease_expires_at=NULL,
      retry_at=now_at,updated_at=now_at,error_code='lease_expired'
      WHERE team_id=t AND status='claimed' AND lease_expires_at<=now_at;
    WITH due AS (
      SELECT notice_id FROM otl.lifecycle_notice_outbox
      WHERE team_id=t AND status IN ('pending','failed') AND attempts<3 AND scheduled_at<=now_at
        AND (retry_at IS NULL OR retry_at<=now_at)
      ORDER BY scheduled_at,notice_id LIMIT batch FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE otl.lifecycle_notice_outbox n SET status='claimed',attempts=attempts+1,
        lease_token=lease,lease_expires_at=now_at+interval '5 minutes',updated_at=now_at
      FROM due WHERE n.notice_id=due.notice_id RETURNING n.*
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('teamId',team_id,'channelId',channel_id,
      'userId',user_id,'effectKey',effect_key,'kind',notice_kind,'revision',lifecycle_revision,
      'scheduledAt',scheduled_at,'attempts',attempts,'leaseToken',lease_token,
      'dmChannelId',dm_channel_id,'payload',payload) ORDER BY scheduled_at,notice_id),'[]'::jsonb)
      INTO claim FROM claimed;
    RETURN claim;
  END IF;

  IF op='prepare_notice' THEN
    UPDATE otl.lifecycle_notice_outbox SET dm_channel_id=p->>'dmChannelId',payload_digest=p->>'payloadDigest',updated_at=now_at
      WHERE team_id=t AND user_id=u AND effect_key=p->>'effectKey' AND status='claimed' AND lease_token=lease;
    GET DIAGNOSTICS processed=ROW_COUNT; RETURN to_jsonb(processed=1);
  END IF;
  IF op='finish_notice' THEN
    IF p->>'status' NOT IN ('sent','failed','dead') THEN RAISE EXCEPTION 'invalid notice status'; END IF;
    UPDATE otl.lifecycle_notice_outbox SET status=CASE
        WHEN p->>'status'='failed' AND attempts>=3 THEN 'dead' ELSE p->>'status' END,
      message_ts=NULLIF(p->>'messageTs',''),
      error_code=NULLIF(p->>'errorCode',''),retry_at=CASE WHEN p->>'retryAt' IS NULL THEN NULL ELSE (p->>'retryAt')::timestamptz END,
      lease_token=NULL,lease_expires_at=NULL,updated_at=now_at
      WHERE team_id=t AND user_id=u AND effect_key=p->>'effectKey' AND status='claimed' AND lease_token=lease;
    GET DIAGNOSTICS processed=ROW_COUNT; RETURN to_jsonb(processed=1);
  END IF;

  IF op='action' THEN
    IF coalesce(c,'')='' OR coalesce(u,'')='' OR coalesce(p->>'key','')='' OR p->>'expectedRevision' !~ '^[0-9]+$'
      THEN RAISE EXCEPTION 'lifecycle action scope required'; END IF;
    IF p->>'actionId'='lifecycle_restore_error' THEN RAISE EXCEPTION 'admin action required'; END IF;
    IF p->>'actionId' NOT IN ('lifecycle_extend','lifecycle_review','lifecycle_stop')
      THEN RAISE EXCEPTION 'invalid lifecycle action'; END IF;
    expected:=(p->>'expectedRevision')::integer;
    SELECT * INTO existing FROM otl.lifecycle_runtime_actions WHERE team_id=t AND user_id=u AND action_key=p->>'key';
    IF FOUND THEN
      IF existing.request_hash<>request_hash THEN RAISE EXCEPTION 'lifecycle action idempotency collision'; END IF;
      RETURN existing.result;
    END IF;
    SELECT * INTO l FROM otl.member_lifecycles WHERE team_id=t AND channel_id=c AND user_id=u FOR UPDATE;
    IF NOT FOUND OR l.revision<>expected THEN RAISE EXCEPTION 'stale lifecycle revision'; END IF;
    IF p->>'actionId'='lifecycle_extend' THEN
      action_result:=otl.lifecycle_execute('extend',p-'actionId');
      SELECT * INTO l FROM otl.member_lifecycles WHERE team_id=t AND user_id=u;
      UPDATE otl.lifecycle_notice_outbox SET status='cancelled',updated_at=now_at
        WHERE team_id=t AND user_id=u AND status IN ('pending','failed') AND notice_kind IN ('three_days','one_day');
      PERFORM otl.lifecycle_enqueue_notice(l,'extension:'||l.revision,'extension',now_at,now_at);
      PERFORM otl.lifecycle_enqueue_notice(l,'grace:'||l.revision||':3d','three_days',
        ((l.grace_deadline-3)::timestamp AT TIME ZONE 'Asia/Seoul'),now_at);
      PERFORM otl.lifecycle_enqueue_notice(l,'grace:'||l.revision||':1d','one_day',
        ((l.grace_deadline-1)::timestamp AT TIME ZONE 'Asia/Seoul'),now_at);
    ELSIF p->>'actionId'='lifecycle_stop' THEN
      IF l.state NOT IN ('active','grace') THEN RAISE EXCEPTION 'lifecycle stop denied'; END IF;
      old_state:=l.state;
      UPDATE otl.member_lifecycles SET state='dormant',revision=revision+1,last_transition_at=now_at,
        grace_started_at=NULL,grace_deadline=NULL WHERE team_id=t AND user_id=u RETURNING * INTO l;
      UPDATE otl.grass_seasons SET closed_at=now_at,closed_on=local_day,closed_reason='voluntary_stop'
        WHERE team_id=t AND user_id=u AND closed_at IS NULL;
      action_result:=otl.lifecycle_member_json(l);
      INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
        from_state,to_state,effective_at,revision,request_hash,result)
      VALUES(t,c,u,p->>'key','season_closed',old_state,'dormant',now_at,l.revision,
        request_hash,action_result) ON CONFLICT DO NOTHING;
      UPDATE otl.lifecycle_notice_outbox SET status='cancelled',updated_at=now_at
        WHERE team_id=t AND user_id=u AND status IN ('pending','failed') AND notice_kind IN ('three_days','one_day');
      PERFORM otl.lifecycle_enqueue_notice(l,'closure:'||l.revision,'closure',now_at,now_at);
    ELSE
      SELECT e.explanation INTO explanation FROM otl.lifecycle_runtime_evaluations e
        WHERE e.team_id=t AND e.user_id=u ORDER BY e.evaluated_at DESC LIMIT 1;
      action_result:=jsonb_build_object('state',l.state,'revision',l.revision,'reviewRequested',true,
        'explanation',coalesce(explanation,'{}'::jsonb));
    END IF;
    INSERT INTO otl.lifecycle_runtime_actions(team_id,channel_id,user_id,action_key,action_type,actor_class,
      expected_revision,resulting_revision,request_hash,result,occurred_at)
    VALUES(t,c,u,p->>'key',p->>'actionId','member',expected,l.revision,request_hash,action_result,now_at);
    RETURN action_result;
  END IF;
  RAISE EXCEPTION 'invalid lifecycle runtime operation';
END $$;

CREATE FUNCTION otl.lifecycle_admin_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId'; now_at timestamptz;
  expected integer; l otl.member_lifecycles; result jsonb; request_hash text:=md5(p::text);
  existing otl.lifecycle_runtime_actions;
BEGIN
  IF op<>'restore_error' OR coalesce(t,'')='' OR coalesce(c,'')='' OR coalesce(u,'')=''
    OR coalesce(p->>'key','')='' OR coalesce(p->>'evidenceKey','')=''
    OR p->>'expectedRevision' !~ '^[0-9]+$' OR coalesce(p->>'now','')=''
    THEN RAISE EXCEPTION 'invalid lifecycle admin action'; END IF;
  now_at:=(p->>'now')::timestamptz; expected:=(p->>'expectedRevision')::integer;
  SELECT * INTO existing FROM otl.lifecycle_runtime_actions WHERE team_id=t AND user_id=u AND action_key=p->>'key';
  IF FOUND THEN
    IF existing.request_hash<>request_hash THEN RAISE EXCEPTION 'lifecycle action idempotency collision'; END IF;
    RETURN existing.result;
  END IF;
  SELECT * INTO l FROM otl.member_lifecycles WHERE team_id=t AND channel_id=c AND user_id=u FOR UPDATE;
  IF NOT FOUND OR l.revision<>expected OR l.state<>'dormant' THEN RAISE EXCEPTION 'lifecycle restore denied'; END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.grass_seasons WHERE team_id=t AND user_id=u AND closed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'closed season required'; END IF;
  UPDATE otl.member_lifecycles SET state='active',revision=revision+1,last_transition_at=now_at,
    extension_used=false WHERE team_id=t AND user_id=u RETURNING * INTO l;
  UPDATE otl.grass_seasons SET closed_at=NULL,closed_on=NULL,closed_reason=NULL
    WHERE season_id=(SELECT season_id FROM otl.grass_seasons WHERE team_id=t AND user_id=u
      AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1);
  result:=otl.lifecycle_member_json(l);
  INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
    from_state,to_state,effective_at,revision,request_hash,result)
  VALUES(t,c,u,p->>'key','reactivated','dormant','active',now_at,l.revision,request_hash,result)
  ON CONFLICT DO NOTHING;
  INSERT INTO otl.lifecycle_runtime_actions(team_id,channel_id,user_id,action_key,action_type,actor_class,
    expected_revision,resulting_revision,request_hash,evidence_key,result,occurred_at)
  VALUES(t,c,u,p->>'key','lifecycle_restore_error','admin',expected,l.revision,request_hash,p->>'evidenceKey',result,now_at);
  PERFORM otl.lifecycle_enqueue_notice(l,'return:'||l.revision,'return',now_at,now_at);
  RETURN result;
END $$;

REVOKE ALL ON TABLE otl.lifecycle_runtime_evaluations,otl.lifecycle_runtime_actions,otl.lifecycle_notice_outbox FROM PUBLIC;
REVOKE ALL ON SEQUENCE otl.lifecycle_runtime_evaluations_evaluation_id_seq,
  otl.lifecycle_runtime_actions_action_id_seq,otl.lifecycle_notice_outbox_notice_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION otl.lifecycle_runtime_audit_immutable(),
  otl.lifecycle_enqueue_notice(otl.member_lifecycles,text,text,timestamptz,timestamptz),
  otl.lifecycle_runtime_execute(text,jsonb),otl.lifecycle_admin_execute(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION otl.lifecycle_runtime_execute(text,jsonb) TO otl_lifecycle_runtime;
GRANT EXECUTE ON FUNCTION otl.lifecycle_admin_execute(text,jsonb) TO otl_lifecycle_admin;

INSERT INTO otl.schema_migrations(version) VALUES('032-lifecycle-runtime-delivery');
COMMIT;
