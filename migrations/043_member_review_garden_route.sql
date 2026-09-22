BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:member-review-garden-route:043',0));

CREATE FUNCTION otl.enqueue_member_review_garden(
  t text, c text, u text, d date, source text, thread text
) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE current_day otl.community_days; delivery_key text;
BEGIN
  IF source !~ '^\d{1,16}\.\d{1,12}$' OR thread !~ '^\d{1,16}\.\d{1,12}$'
  THEN RAISE EXCEPTION 'invalid member review garden route'; END IF;
  SELECT * INTO current_day FROM otl.community_days
    WHERE team_id=t AND channel_id=c AND user_id=u AND day=d FOR UPDATE;
  IF NOT FOUND OR (current_day.outcome='pending' AND current_day.reflection='') THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u,d)::text,31));
  UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,
    lease_expires_at=NULL,retry_after=NULL,updated_at=transaction_timestamp()
   WHERE team_id=t AND channel_id=c AND user_id=u AND day=d AND thread_ts<>thread
     AND status IN ('pending','failed');
  delivery_key:=otl.enqueue_garden_projection(
    t,c,u,d,current_day.revision,source,thread,'review_prompt','recorded',NULL
  );
  RETURN delivery_key;
END $$;

CREATE FUNCTION otl.route_member_review_garden(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE delivery_key text;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'channelId','')=''
    OR coalesce(p->>'userId','')='' OR coalesce(p->>'date','')=''
    OR coalesce(p->>'sourceTs','')='' OR coalesce(p->>'threadTs','')=''
  THEN RAISE EXCEPTION 'member review garden scope required'; END IF;
  delivery_key:=otl.enqueue_member_review_garden(
    p->>'teamId',p->>'channelId',p->>'userId',(p->>'date')::date,p->>'sourceTs',p->>'threadTs'
  );
  RETURN CASE WHEN delivery_key IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object('deliveryKey',delivery_key) END;
END $$;

REVOKE ALL ON FUNCTION otl.enqueue_member_review_garden(text,text,text,date,text,text),
  otl.route_member_review_garden(jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('043-member-review-garden-route');
COMMIT;
