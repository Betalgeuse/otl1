BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:garden-projection-consistency:025',0));

ALTER TABLE otl.community_garden_deliveries DROP CONSTRAINT community_garden_deliveries_day_revision_check;
ALTER TABLE otl.community_garden_deliveries ADD CONSTRAINT community_garden_deliveries_day_revision_check CHECK(day_revision>=0);
DO $$ DECLARE name text; BEGIN
 SELECT conname INTO name FROM pg_constraint WHERE conrelid='otl.community_garden_deliveries'::regclass AND contype='u'
 AND pg_get_constraintdef(oid) LIKE '%day_revision%' LIMIT 1;
 IF name IS NOT NULL THEN EXECUTE format('ALTER TABLE otl.community_garden_deliveries DROP CONSTRAINT %I',name); END IF;
END $$;
ALTER TABLE otl.community_garden_deliveries
 ADD COLUMN delivery_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 ADD COLUMN projection_key text,
 ADD COLUMN route_kind text CHECK(route_kind IN ('interaction','goal_prompt','review_prompt')),
 ADD COLUMN route_provenance text CHECK(route_provenance IN ('recorded','daily_prompt_fallback')),
 ADD COLUMN payload jsonb;

CREATE TABLE otl.community_garden_projections(
 team_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL, day date NOT NULL, thread_ts text NOT NULL,
 projection_key text NOT NULL UNIQUE, source_ts text NOT NULL,
 route_kind text NOT NULL CHECK(route_kind IN ('interaction','goal_prompt','review_prompt')),
 route_provenance text NOT NULL CHECK(route_provenance IN ('recorded','daily_prompt_fallback')),
 desired_revision integer NOT NULL CHECK(desired_revision>=0), published_revision integer CHECK(published_revision>=0),
 message_ts text, payload_digest text CHECK(payload_digest IS NULL OR payload_digest~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,channel_id,user_id,day,thread_ts)
);
CREATE TABLE otl.community_garden_reconciliations(
 team_id text NOT NULL, channel_id text NOT NULL, reconciliation_key text NOT NULL,
 result jsonb NOT NULL, result_digest text NOT NULL CHECK(result_digest~'^[0-9a-f]{32}$'), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,channel_id,reconciliation_key)
);

UPDATE otl.community_garden_deliveries SET
 projection_key=md5(concat_ws(E'\x1f',team_id,channel_id,user_id,day::text,thread_ts)),
 route_kind='interaction',route_provenance='recorded';
INSERT INTO otl.community_garden_projections(team_id,channel_id,user_id,day,thread_ts,projection_key,source_ts,route_kind,route_provenance,desired_revision,published_revision,message_ts,payload_digest)
WITH desired AS(
 SELECT DISTINCT ON(team_id,channel_id,user_id,day,thread_ts) * FROM otl.community_garden_deliveries
 ORDER BY team_id,channel_id,user_id,day,thread_ts,day_revision DESC,updated_at DESC,created_at DESC,delivery_id DESC,delivery_key DESC,source_ts DESC
),published AS(
 SELECT DISTINCT ON(team_id,channel_id,user_id,day,thread_ts) * FROM otl.community_garden_deliveries WHERE status='sent'
 ORDER BY team_id,channel_id,user_id,day,thread_ts,day_revision DESC,updated_at DESC,created_at DESC,delivery_id DESC,delivery_key DESC,source_ts DESC
)
SELECT d.team_id,d.channel_id,d.user_id,d.day,d.thread_ts,d.projection_key,d.source_ts,'interaction','recorded',d.day_revision,
 p.day_revision,p.message_ts,p.payload_digest FROM desired d LEFT JOIN published p USING(team_id,channel_id,user_id,day,thread_ts);
UPDATE otl.community_garden_deliveries d SET status='cancelled',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,updated_at=now()
WHERE d.status IN ('pending','failed','claimed') AND EXISTS(SELECT 1 FROM otl.community_garden_projections p WHERE p.projection_key=d.projection_key AND p.desired_revision>d.day_revision);
ALTER TABLE otl.community_garden_deliveries ALTER COLUMN projection_key SET NOT NULL,ALTER COLUMN route_kind SET NOT NULL,ALTER COLUMN route_provenance SET NOT NULL;
ALTER TABLE otl.community_garden_deliveries ADD CONSTRAINT community_garden_delivery_route_revision UNIQUE(team_id,channel_id,user_id,day,thread_ts,day_revision);

CREATE FUNCTION otl.garden_projection_key(t text,c text,u text,d date,thread text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,otl AS $$ SELECT md5(concat_ws(E'\x1f',t,c,u,d::text,thread)) $$;
CREATE FUNCTION otl.enqueue_garden_projection(t text,c text,u text,d date,rev integer,source text,thread text,kind text,provenance text,undo text)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE pk text:=otl.garden_projection_key(t,c,u,d,thread); dk text;
BEGIN
 IF rev<0 OR source !~ '^\d{1,16}\.\d{1,12}$' OR thread !~ '^\d{1,16}\.\d{1,12}$'
  OR kind NOT IN ('interaction','goal_prompt','review_prompt') OR provenance NOT IN ('recorded','daily_prompt_fallback')
 THEN RAISE EXCEPTION 'invalid garden projection'; END IF;
 dk:=format('garden:v2:%s:r%s:t%s:s%s',d::text,rev,substr(md5(thread),1,12),substr(md5(source),1,8));
 INSERT INTO otl.community_garden_projections(team_id,channel_id,user_id,day,thread_ts,projection_key,source_ts,route_kind,route_provenance,desired_revision)
 VALUES(t,c,u,d,thread,pk,source,kind,provenance,rev)
 ON CONFLICT(team_id,channel_id,user_id,day,thread_ts) DO UPDATE SET
  source_ts=excluded.source_ts,route_kind=excluded.route_kind,route_provenance=excluded.route_provenance,
  desired_revision=greatest(otl.community_garden_projections.desired_revision,excluded.desired_revision),updated_at=now();
 UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,updated_at=now()
 WHERE team_id=t AND channel_id=c AND user_id=u AND day=d AND thread_ts=thread AND status IN ('pending','failed') AND day_revision<>rev;
 INSERT INTO otl.community_garden_deliveries(team_id,channel_id,user_id,delivery_key,day,day_revision,source_ts,thread_ts,undo_key,projection_key,route_kind,route_provenance)
 VALUES(t,c,u,dk,d,rev,source,thread,undo,pk,kind,provenance)
 ON CONFLICT(team_id,channel_id,user_id,day,thread_ts,day_revision) DO NOTHING;
 SELECT delivery_key INTO dk FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c AND user_id=u AND day=d AND thread_ts=thread AND day_revision=rev;
 RETURN dk;
END $$;
REVOKE ALL ON FUNCTION otl.garden_projection_key(text,text,text,date,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION otl.enqueue_garden_projection(text,text,text,date,integer,text,text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION otl.community_garden_delivery_json(d otl.community_garden_deliveries) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,otl AS $$ SELECT jsonb_build_object(
 'teamId',d.team_id,'channelId',d.channel_id,'userId',d.user_id,'deliveryKey',d.delivery_key,'date',d.day::text,
 'revision',d.day_revision,'source',d.source_ts,'thread',d.thread_ts,'undoKey',d.undo_key,'status',d.status,
 'attempts',d.attempts,'leaseToken',d.lease_token,'payloadDigest',d.payload_digest,'messageTs',d.message_ts,
 'deliveryId',d.delivery_id,'projectionKey',d.projection_key,'routeKind',d.route_kind,'routeProvenance',d.route_provenance) $$;

ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_projections;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_projections(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId';c text:=p->>'channelId';u text:=p->>'userId';k text:=p->>'deliveryKey';result jsonb;route jsonb;
 gd otl.community_garden_deliveries;proj otl.community_garden_projections;day_row otl.community_days;dk text;prompt record;
 from_day date;through_day date;lim integer;dry boolean;before_p integer;before_d integer;after_p integer;after_d integer;
 planned integer;fallbacks integer;unroutable integer;current_count integer;profile_repairs integer:=0;digest text;request_digest text;rec record;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
 IF op='change' THEN
  result:=otl.community_execute_before_projections(op,p-'delivery');
  IF coalesce((result->>'changed')::boolean,false) AND NOT coalesce((result->>'conflict')::boolean,false) AND p?'delivery' THEN
   route:=p->'delivery';
   SELECT * INTO day_row FROM otl.community_days WHERE team_id=t AND channel_id=c AND user_id=u AND day=(result#>>'{day,date}')::date;
   dk:=otl.enqueue_garden_projection(t,c,u,day_row.day,day_row.revision,route->>'source',route->>'thread','interaction','recorded',
    CASE WHEN coalesce((p->>'preserveOutcome')::boolean,false) OR p->>'action'='undo' THEN NULL ELSE 'undo:'||(result->>'undoKey') END);
   FOR prompt IN SELECT r.body->>'ts' ts,r.body->>'kind' kind FROM otl.community_records r
    WHERE r.team_id=t AND r.channel_id=c AND r.kind='prompt' AND r.body->>'date'=day_row.day::text
    AND r.body->>'ts'~'^\d{1,16}\.\d{1,12}$' AND ((r.body->>'kind'='goal' AND day_row.goal<>'') OR (r.body->>'kind'='review' AND day_row.reflection<>''))
    ORDER BY r.updated_at DESC LOOP
    PERFORM otl.enqueue_garden_projection(t,c,u,day_row.day,day_row.revision,prompt.ts,prompt.ts,prompt.kind||'_prompt','daily_prompt_fallback',NULL);
   END LOOP;
   RETURN result||jsonb_build_object('gardenDeliveryKey',dk);
  END IF;
  RETURN result;
 END IF;
 IF op='claim_garden_delivery' THEN
  UPDATE otl.community_garden_deliveries d SET status='cancelled',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,updated_at=now()
   WHERE d.team_id=t AND d.channel_id=c AND d.status IN ('pending','failed','claimed') AND EXISTS(
    SELECT 1 FROM otl.community_garden_projections x WHERE x.projection_key=d.projection_key AND x.desired_revision<>d.day_revision);
  RETURN otl.community_execute_before_projections(op,p);
 END IF;
 IF op='prepare_garden_delivery' THEN
  SELECT * INTO gd FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k FOR UPDATE;
  SELECT * INTO proj FROM otl.community_garden_projections WHERE projection_key=gd.projection_key;
  IF gd.status='claimed' AND gd.lease_token=p->>'leaseToken' AND proj.desired_revision<>gd.day_revision THEN
   UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k; RETURN 'false'::jsonb;
  END IF;
  IF gd.status<>'claimed' OR gd.lease_token<>p->>'leaseToken' OR coalesce(p->>'payloadDigest','')!~'^[0-9a-f]{64}$' OR jsonb_typeof(p->'payload')<>'object'
   THEN RETURN 'false'::jsonb; END IF;
  UPDATE otl.community_garden_deliveries SET payload_digest=coalesce(payload_digest,p->>'payloadDigest'),payload=coalesce(payload,p->'payload'),updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k RETURNING * INTO gd;
  RETURN jsonb_build_object('payloadDigest',gd.payload_digest,'payload',gd.payload);
 END IF;
 IF op='finish_garden_delivery' THEN
  SELECT * INTO gd FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k;
  result:=otl.community_execute_before_projections(op,p);
  IF result='true'::jsonb AND p->>'status'='sent' THEN
   UPDATE otl.community_garden_projections SET published_revision=gd.day_revision,message_ts=p->>'messageTs',payload_digest=gd.payload_digest,updated_at=now()
    WHERE projection_key=gd.projection_key AND desired_revision=gd.day_revision;
  END IF; RETURN result;
 END IF;
 IF op='reconcile_garden_projections' THEN
  through_day:=(p->>'through')::date;from_day:=coalesce((p->>'from')::date,through_day-interval '90 days');
  lim:=least(greatest(coalesce((p->>'limit')::integer,100),1),100);dry:=coalesce((p->>'dryRun')::boolean,true);request_digest:=md5((p-'dryRun')::text);
  IF through_day<from_day OR length(coalesce(p->>'reconciliationKey','')) NOT BETWEEN 3 AND 100 THEN RAISE EXCEPTION 'invalid reconciliation scope'; END IF;
  IF NOT dry THEN SELECT gr.result INTO result FROM otl.community_garden_reconciliations gr WHERE gr.team_id=t AND gr.channel_id=c AND gr.reconciliation_key=p->>'reconciliationKey';
   IF FOUND THEN IF result->>'requestDigest' IS DISTINCT FROM request_digest THEN RAISE EXCEPTION 'reconciliation key scope mismatch'; END IF; RETURN result||jsonb_build_object('replayed',true,'insertedRoutes',0,'deliveriesEnqueued',0); END IF; END IF;
  CREATE TEMP TABLE garden_plan ON COMMIT DROP AS
  SELECT d.*,coalesce(i.source_ts,q.ts) route_source,coalesce(i.thread_ts,q.ts) route_thread,
   CASE WHEN i.thread_ts IS NOT NULL THEN 'interaction' ELSE q.kind||'_prompt' END route_kind,
   CASE WHEN i.thread_ts IS NOT NULL THEN 'recorded' ELSE 'daily_prompt_fallback' END provenance
  FROM (SELECT * FROM otl.community_days WHERE team_id=t AND channel_id=c AND day BETWEEN from_day AND through_day
    AND (u IS NULL OR user_id=u) AND (goal<>'' OR reflection<>'' OR resting OR outcome<>'pending') ORDER BY day,user_id LIMIT lim) d
  LEFT JOIN LATERAL(SELECT r.body->>'source' source_ts,r.body->>'thread' thread_ts FROM otl.community_records r
    WHERE r.team_id=d.team_id AND r.channel_id=d.channel_id AND r.user_id=d.user_id AND r.kind IN ('pending','reflection_outcome','undo')
    AND r.body->>'date'=d.day::text AND r.body->>'source'~'^\d{1,16}\.\d{1,12}$' AND r.body->>'thread'~'^\d{1,16}\.\d{1,12}$'
    ORDER BY r.updated_at DESC LIMIT 1)i ON true
  LEFT JOIN LATERAL(SELECT r.body->>'ts' ts,r.body->>'kind' kind FROM otl.community_records r
    WHERE r.team_id=d.team_id AND r.channel_id=d.channel_id AND r.kind='prompt' AND r.body->>'date'=d.day::text
    AND r.body->>'ts'~'^\d{1,16}\.\d{1,12}$' AND ((r.body->>'kind'='goal' AND d.goal<>'') OR (r.body->>'kind'='review' AND d.reflection<>''))
    ORDER BY CASE r.body->>'kind' WHEN 'goal' THEN 0 ELSE 1 END,r.updated_at DESC LIMIT 1)q ON i.thread_ts IS NULL;
  SELECT count(*) FILTER(WHERE route_thread IS NOT NULL),count(*) FILTER(WHERE provenance='daily_prompt_fallback'),count(*) FILTER(WHERE route_thread IS NULL) INTO planned,fallbacks,unroutable FROM garden_plan;
  SELECT count(*) INTO current_count FROM garden_plan x JOIN otl.community_garden_projections g ON g.team_id=x.team_id AND g.channel_id=x.channel_id AND g.user_id=x.user_id AND g.day=x.day AND g.thread_ts=x.route_thread AND g.desired_revision=x.revision;
  SELECT count(*) INTO before_p FROM otl.community_garden_projections WHERE team_id=t AND channel_id=c;
  SELECT count(*) INTO before_d FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c;
  SELECT count(*) INTO profile_repairs FROM otl.profiles p0 JOIN (SELECT user_id,min(day) min_day FROM otl.community_days WHERE team_id=t AND channel_id=c AND goal<>'' GROUP BY user_id) mins USING(user_id)
   WHERE p0.team_id=t AND p0.start_date>mins.min_day;
  IF NOT dry THEN
   FOR rec IN SELECT * FROM garden_plan WHERE route_thread IS NOT NULL LOOP
    PERFORM otl.enqueue_garden_projection(rec.team_id,rec.channel_id,rec.user_id,rec.day,rec.revision,rec.route_source,rec.route_thread,rec.route_kind,rec.provenance,NULL);
   END LOOP;
   WITH mins AS(SELECT user_id,min(day) min_day FROM otl.community_days WHERE team_id=t AND channel_id=c AND goal<>'' GROUP BY user_id)
   UPDATE otl.profiles p0 SET start_date=mins.min_day FROM mins WHERE p0.team_id=t AND p0.user_id=mins.user_id AND p0.start_date>mins.min_day;
   GET DIAGNOSTICS profile_repairs=ROW_COUNT;
  END IF;
  SELECT count(*) INTO after_p FROM otl.community_garden_projections WHERE team_id=t AND channel_id=c;
  SELECT count(*) INTO after_d FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c;
  digest:=md5(coalesce((SELECT string_agg(concat_ws(':',user_id,day,revision,route_thread),',' ORDER BY user_id,day) FROM garden_plan WHERE route_thread IS NOT NULL),''));
  result:=jsonb_build_object('plannedRoutes',planned,'fallbackRoutes',fallbacks,'unroutableDays',unroutable,'alreadyCurrent',current_count,
   'insertedRoutes',after_p-before_p,'deliveriesEnqueued',after_d-before_d,'profileRepairs',profile_repairs,'planDigest',digest,'requestDigest',request_digest,'dryRun',dry,'replayed',false);
  IF NOT dry THEN INSERT INTO otl.community_garden_reconciliations VALUES(t,c,p->>'reconciliationKey',result,md5(result::text),now()); END IF;
  RETURN result;
 END IF;
 RETURN otl.community_execute_before_projections(op,p);
END $$;
REVOKE ALL ON FUNCTION otl.community_execute(text,jsonb) FROM PUBLIC;
INSERT INTO otl.schema_migrations(version) VALUES('025-garden-projection-consistency');
COMMIT;
