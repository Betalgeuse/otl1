BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:dormant-return:033',0));

CREATE FUNCTION otl.lifecycle_eligibility_sync() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
BEGIN
  IF NEW.state=OLD.state THEN RETURN NEW; END IF;
  IF NEW.state='dormant' THEN
    UPDATE otl.member_referral_links SET status='paused',status_changed_at=NEW.last_transition_at
      WHERE team_id=NEW.team_id AND referrer_user_id=NEW.user_id AND status='active';
    UPDATE otl.community_records SET status='cancelled',reminder_lease_token=NULL,
      reminder_lease_expires_at=NULL,reminder_retry_after=NULL,updated_at=NEW.last_transition_at
      WHERE team_id=NEW.team_id AND user_id=NEW.user_id AND kind='reminder'
        AND status IN ('pending','claimed','failed');
    UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,
      lease_expires_at=NULL,retry_after=NULL,updated_at=NEW.last_transition_at
      WHERE team_id=NEW.team_id AND user_id=NEW.user_id AND status IN ('pending','claimed','failed');
  ELSIF NEW.state='active' THEN
    UPDATE otl.member_referral_links SET status='active',status_changed_at=NEW.last_transition_at
      WHERE team_id=NEW.team_id AND referrer_user_id=NEW.user_id AND status='paused';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_eligibility_sync AFTER UPDATE OF state ON otl.member_lifecycles
  FOR EACH ROW EXECUTE FUNCTION otl.lifecycle_eligibility_sync();

CREATE OR REPLACE FUNCTION otl.reminder_eligible(t text,c text,u text,kind text,local_now timestamp)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
 SELECT EXISTS (
  SELECT 1 FROM otl.community_preferences p
  JOIN otl.workspace_members m USING(team_id,user_id)
  JOIN otl.workspace_channel_memberships cm USING(team_id,channel_id,user_id)
  JOIN otl.member_lifecycles l USING(team_id,channel_id,user_id)
  LEFT JOIN otl.community_days d ON d.team_id=p.team_id AND d.channel_id=p.channel_id
    AND d.user_id=p.user_id AND d.day=local_now::date
  WHERE p.team_id=t AND p.channel_id=c AND p.user_id=u AND p.enabled AND cm.is_current
    AND l.state='active' AND p.eligible_from<=local_now::date AND NOT coalesce(m.is_bot,false)
    AND NOT coalesce(m.is_app_user,false) AND NOT coalesce(m.slack_deleted,false)
    AND extract(isodow FROM local_now)<6 AND local_now::time>='08:00'::time AND local_now::time<'22:00'::time
    AND NOT coalesce(d.resting,false)
    AND ((kind='goal' AND local_now::time>=p.goal_time AND coalesce(d.goal,'')='')
      OR (kind='review' AND local_now::time>=p.review_time AND coalesce(d.goal,'')<>''
        AND coalesce(d.reflection,'')=''))
 )
$$;
REVOKE EXECUTE ON FUNCTION otl.reminder_eligible(text,text,text,text,timestamp) FROM PUBLIC;

ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_dormant_return;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_dormant_return(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId'; action text:=p->>'action';
  target_day date; local_day date; expected integer; l otl.member_lifecycles;
  result jsonb; season bigint; return_event_key text; now_at timestamptz;
BEGIN
  IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
  IF op='lifecycle_eligibility' THEN
    SELECT * INTO l FROM otl.member_lifecycles WHERE team_id=t AND channel_id=c AND user_id=u;
    IF NOT FOUND THEN RETURN jsonb_build_object('state','active','revision',NULL); END IF;
    RETURN jsonb_build_object('state',l.state,'revision',l.revision);
  END IF;
  IF op='members' THEN
    RETURN (SELECT coalesce(jsonb_agg(cm.user_id ORDER BY cm.user_id),'[]'::jsonb)
      FROM otl.workspace_channel_memberships cm
      JOIN otl.workspace_members m USING(team_id,user_id)
      JOIN otl.member_lifecycles lf USING(team_id,channel_id,user_id)
      WHERE cm.team_id=t AND cm.channel_id=c AND cm.is_current AND lf.state='active'
        AND NOT coalesce(m.is_bot,false) AND NOT coalesce(m.is_app_user,false)
        AND NOT coalesce(m.slack_deleted,false));
  END IF;
  IF op='list_days' THEN
    RETURN (SELECT coalesce(jsonb_agg(otl.community_day_json(d) ORDER BY d.user_id),'[]'::jsonb)
      FROM otl.community_days d JOIN otl.member_lifecycles lf USING(team_id,channel_id,user_id)
      WHERE d.team_id=t AND d.channel_id=c AND d.day=(p->>'date')::date AND lf.state='active');
  END IF;
  IF op='route_review_garden' AND EXISTS(
    SELECT 1 FROM otl.member_lifecycles WHERE team_id=t AND channel_id=c AND user_id=u AND state='dormant'
  ) THEN RETURN 'null'::jsonb; END IF;
  IF op<>'change' THEN RETURN otl.community_execute_before_dormant_return(op,p); END IF;

  SELECT * INTO l FROM otl.member_lifecycles
    WHERE team_id=t AND channel_id=c AND user_id=u FOR UPDATE;
  IF FOUND AND p->>'expectedLifecycleRevision' ~ '^[0-9]+$' AND
    l.revision<>(p->>'expectedLifecycleRevision')::integer
  THEN RAISE EXCEPTION 'stale lifecycle revision'; END IF;
  IF NOT FOUND OR l.state<>'dormant' THEN
    RETURN otl.community_execute_before_dormant_return(op,p);
  END IF;
  now_at:=coalesce((p->>'now')::timestamptz,transaction_timestamp());
  local_day:=(now_at AT TIME ZONE 'Asia/Seoul')::date;
  target_day:=(p->>'date')::date;
  IF action<>'goal' OR target_day<>local_day THEN
    RAISE EXCEPTION 'new current goal required to return';
  END IF;
  IF p->>'expectedLifecycleRevision' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'lifecycle revision required';
  END IF;
  expected:=(p->>'expectedLifecycleRevision')::integer;
  IF l.revision<>expected THEN RAISE EXCEPTION 'stale lifecycle revision'; END IF;
  return_event_key:='return:'||(p->>'key');
  IF EXISTS(SELECT 1 FROM otl.member_lifecycle_events e
    WHERE e.team_id=t AND e.user_id=u AND e.event_key=return_event_key) THEN
    RETURN otl.community_execute_before_dormant_return(op,p);
  END IF;
  result:=otl.community_execute_before_dormant_return(op,p);
  IF coalesce((result->>'changed')::boolean,false)=false OR coalesce((result->>'conflict')::boolean,false)
  THEN RETURN result; END IF;
  UPDATE otl.member_lifecycles SET state='active',revision=revision+1,last_transition_at=now_at,
    grace_started_at=NULL,grace_deadline=NULL,extension_used=false
    WHERE team_id=t AND user_id=u RETURNING * INTO l;
  INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
    VALUES(t,c,u,now_at,local_day,'return') RETURNING season_id INTO season;
  UPDATE otl.lifecycle_notice_outbox SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,
    retry_at=NULL,updated_at=now_at
    WHERE team_id=t AND user_id=u AND status IN ('pending','claimed','failed');
  result:=result||jsonb_build_object('returnTransition',jsonb_build_object(
    'kind','welcome_back','lifecycleRevision',l.revision,'seasonId',season,
    'effectKey','return:'||l.revision));
  INSERT INTO otl.member_lifecycle_events(team_id,channel_id,user_id,event_key,event_type,
    from_state,to_state,effective_at,service_date,revision,request_hash,result)
  VALUES(t,c,u,return_event_key,'reactivated','dormant','active',now_at,local_day,l.revision,md5(p::text),result);
  PERFORM otl.lifecycle_enqueue_notice(l,'return:'||l.revision,'return',now_at,now_at);
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION otl.lifecycle_eligibility_sync(),otl.community_execute(text,jsonb) FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('033-dormant-return');
COMMIT;
