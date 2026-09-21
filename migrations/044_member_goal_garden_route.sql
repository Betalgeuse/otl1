BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:member-goal-garden-route:044',0));

CREATE FUNCTION otl.enqueue_member_goal_garden(
  t text, c text, u text, d date, source text, thread text
) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE current_day otl.community_days; delivery_key text;
BEGIN
  IF source !~ '^\d{1,16}\.\d{1,12}$' OR thread !~ '^\d{1,16}\.\d{1,12}$'
  THEN RAISE EXCEPTION 'invalid member goal garden route'; END IF;
  SELECT * INTO current_day FROM otl.community_days
    WHERE team_id=t AND channel_id=c AND user_id=u AND day=d FOR UPDATE;
  IF NOT FOUND OR current_day.goal='' THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u,d)::text,31));
  delivery_key:=otl.enqueue_garden_projection(
    t,c,u,d,current_day.revision,source,thread,'goal_prompt','recorded',NULL
  );
  RETURN delivery_key;
END $$;

CREATE FUNCTION otl.route_member_goal_garden(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE delivery_key text;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'channelId','')=''
    OR coalesce(p->>'userId','')='' OR coalesce(p->>'date','')=''
    OR coalesce(p->>'sourceTs','')='' OR coalesce(p->>'threadTs','')=''
  THEN RAISE EXCEPTION 'member goal garden scope required'; END IF;
  delivery_key:=otl.enqueue_member_goal_garden(
    p->>'teamId',p->>'channelId',p->>'userId',(p->>'date')::date,p->>'sourceTs',p->>'threadTs'
  );
  RETURN CASE WHEN delivery_key IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object('deliveryKey',delivery_key) END;
END $$;

REVOKE ALL ON FUNCTION otl.enqueue_member_goal_garden(text,text,text,date,text,text),
  otl.route_member_goal_garden(jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('044-member-goal-garden-route');
COMMIT;
