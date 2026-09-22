BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:review-thread-gardens:031',0));

INSERT INTO otl_archive.migration_snapshots(migration,table_name,rows)
 SELECT '031','community_garden_projections',coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb)
 FROM otl.community_garden_projections p;
INSERT INTO otl_archive.migration_snapshots(migration,table_name,rows)
 SELECT '031','community_garden_deliveries',coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb)
 FROM otl.community_garden_deliveries d;

DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint
 WHERE conrelid='otl.community_garden_projections'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%route_provenance%';
 IF constraint_name IS NOT NULL THEN
   EXECUTE format('ALTER TABLE otl.community_garden_projections DROP CONSTRAINT %I',constraint_name);
 END IF;
 SELECT conname INTO constraint_name FROM pg_constraint
 WHERE conrelid='otl.community_garden_deliveries'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%route_provenance%';
 IF constraint_name IS NOT NULL THEN
   EXECUTE format('ALTER TABLE otl.community_garden_deliveries DROP CONSTRAINT %I',constraint_name);
 END IF;
END $$;
ALTER TABLE otl.community_garden_projections ADD CONSTRAINT community_garden_projection_provenance_check
  CHECK(route_provenance IN ('recorded','daily_prompt_fallback','canonical_review'));
ALTER TABLE otl.community_garden_deliveries ADD CONSTRAINT community_garden_delivery_provenance_check
  CHECK(route_provenance IN ('recorded','daily_prompt_fallback','canonical_review'));

CREATE TABLE otl.community_review_roots(
  team_id text NOT NULL,
  channel_id text NOT NULL,
  day date NOT NULL,
  root_key text NOT NULL,
  thread_ts text NOT NULL CHECK(thread_ts~'^\d{1,16}\.\d{1,12}$'),
  bound_by_user_id text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(team_id,channel_id,day),
  UNIQUE(team_id,channel_id,thread_ts),
  CHECK(root_key='common-thread:'||day::text||':review')
);

CREATE TABLE otl.community_review_reconciliations(
  team_id text NOT NULL,
  channel_id text NOT NULL,
  reconciliation_key text NOT NULL CHECK(length(reconciliation_key) BETWEEN 3 AND 100),
  request_digest text NOT NULL CHECK(request_digest~'^[0-9a-f]{32}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(team_id,channel_id,reconciliation_key)
);

CREATE TABLE otl.community_garden_retirements(
  retirement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  day date NOT NULL,
  canonical_projection_key text NOT NULL,
  old_projection_key text NOT NULL,
  old_message_ts text NOT NULL CHECK(old_message_ts~'^\d{1,16}\.\d{1,12}$'),
  old_payload jsonb NOT NULL CHECK(jsonb_typeof(old_payload)='object'),
  action text NOT NULL DEFAULT 'update' CHECK(action='update'),
  preserve_replies boolean NOT NULL DEFAULT true CHECK(preserve_replies),
  status text NOT NULL DEFAULT 'held' CHECK(status IN (
    'held','pending','claimed','retired','failed','restore_claimed','restored','restore_failed'
  )),
  attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  error_code text,
  replacement_message_ts text CHECK(replacement_message_ts IS NULL OR replacement_message_ts~'^\d{1,16}\.\d{1,12}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(team_id,channel_id,old_message_ts),
  CHECK((status IN ('claimed','restore_claimed'))=(worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX community_garden_retirement_due_idx
  ON otl.community_garden_retirements(team_id,channel_id,status,retry_after,updated_at)
  WHERE status IN ('held','pending','claimed','failed','retired','restore_failed');

CREATE FUNCTION otl.review_root_ts(t text,c text,d date) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,otl AS $$
 SELECT root.thread_ts FROM otl.community_review_roots root
 JOIN otl.community_records anchor ON anchor.team_id=root.team_id AND anchor.channel_id=root.channel_id
   AND anchor.record_key=root.root_key AND anchor.kind='prompt'
 JOIN otl.community_records dispatch ON dispatch.team_id=root.team_id AND dispatch.channel_id=root.channel_id
   AND dispatch.record_key='common:'||root.day::text||':review' AND dispatch.kind='dispatch'
 WHERE root.team_id=t AND root.channel_id=c AND root.day=d
   AND anchor.body->>'date'=d::text AND anchor.body->>'kind'='review'
   AND anchor.body->>'ts'=root.thread_ts AND dispatch.status='sent'
   AND dispatch.body->>'date'=d::text AND dispatch.body->>'kind'='review'
   AND dispatch.body->>'messageTs'=root.thread_ts
$$;

CREATE OR REPLACE FUNCTION otl.enqueue_garden_projection(t text,c text,u text,d date,rev integer,
  source text,thread text,kind text,provenance text,undo text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE pk text:=otl.garden_projection_key(t,c,u,d,thread); dk text;
BEGIN
 IF rev<0 OR source!~'^\d{1,16}\.\d{1,12}$' OR thread!~'^\d{1,16}\.\d{1,12}$'
  OR kind NOT IN ('interaction','goal_prompt','review_prompt')
  OR provenance NOT IN ('recorded','daily_prompt_fallback','canonical_review')
 THEN RAISE EXCEPTION 'invalid garden projection'; END IF;
 dk:=format('garden:v2:%s:r%s:t%s:s%s',d::text,rev,substr(md5(thread),1,12),substr(md5(source),1,8));
 INSERT INTO otl.community_garden_projections(team_id,channel_id,user_id,day,thread_ts,projection_key,
   source_ts,route_kind,route_provenance,desired_revision)
 VALUES(t,c,u,d,thread,pk,source,kind,provenance,rev)
 ON CONFLICT(team_id,channel_id,user_id,day,thread_ts) DO UPDATE SET source_ts=excluded.source_ts,
  route_kind=excluded.route_kind,route_provenance=excluded.route_provenance,
  desired_revision=greatest(otl.community_garden_projections.desired_revision,excluded.desired_revision),updated_at=transaction_timestamp();
 UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,
  lease_expires_at=NULL,retry_after=NULL,updated_at=transaction_timestamp()
 WHERE team_id=t AND channel_id=c AND user_id=u AND day=d AND thread_ts=thread
  AND status IN ('pending','failed','claimed') AND day_revision<>rev;
 INSERT INTO otl.community_garden_deliveries(team_id,channel_id,user_id,delivery_key,day,day_revision,
   source_ts,thread_ts,undo_key,projection_key,route_kind,route_provenance)
 VALUES(t,c,u,dk,d,rev,source,thread,undo,pk,kind,provenance)
 ON CONFLICT(team_id,channel_id,user_id,day,thread_ts,day_revision) DO NOTHING;
 UPDATE otl.community_garden_deliveries SET source_ts=source,route_kind=kind,
  route_provenance=provenance,updated_at=transaction_timestamp()
 WHERE team_id=t AND channel_id=c AND user_id=u AND day=d AND thread_ts=thread AND day_revision=rev;
 SELECT delivery_key INTO dk FROM otl.community_garden_deliveries
  WHERE team_id=t AND channel_id=c AND user_id=u AND day=d AND thread_ts=thread AND day_revision=rev;
 RETURN dk;
END $$;

CREATE FUNCTION otl.enqueue_review_garden(t text,c text,u text,d date,source text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE root text; current_day otl.community_days; delivery_key text;
BEGIN
 IF source!~'^\d{1,16}\.\d{1,12}$' THEN RAISE EXCEPTION 'invalid review garden source'; END IF;
 SELECT * INTO current_day FROM otl.community_days
  WHERE team_id=t AND channel_id=c AND user_id=u AND day=d FOR UPDATE;
 IF NOT FOUND OR (current_day.outcome='pending' AND current_day.reflection='') THEN RETURN NULL; END IF;
 root:=otl.review_root_ts(t,c,d);
 IF root IS NULL THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,u,d)::text,31));
 UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,
  lease_expires_at=NULL,retry_after=NULL,updated_at=transaction_timestamp()
 WHERE team_id=t AND channel_id=c AND user_id=u AND day=d
  AND thread_ts<>root
  AND status IN ('pending','claimed','failed');
 delivery_key:=otl.enqueue_garden_projection(t,c,u,d,current_day.revision,source,root,
  'review_prompt','canonical_review',NULL);
 RETURN delivery_key;
END $$;

ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_review_thread;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_review_thread(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId';
 target_day date; root text; root_record otl.community_records; dispatch otl.community_records;
 current_count integer; before_deliveries integer; after_deliveries integer; enqueued integer:=0;
 row_day otl.community_days; chosen_batch text; lease text:=p->>'leaseToken'; affected integer;
 attempt integer; local_now timestamp; retry_seconds integer; error_code text:=p->>'errorCode';
 now_at timestamptz;
 from_day date; through_day date; lim integer; dry boolean; request_digest text; result jsonb;
 existing otl.community_review_reconciliations; retirement otl.community_garden_retirements;
 plan_row record;
 cancelled_count integer:=0; retirement_count integer:=0; missing_payload integer:=0;
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;

 IF op='bind_review_root' THEN
  target_day:=(p->>'date')::date; root:=p->>'messageTs';
  IF coalesce(u,'')='' OR root!~'^\d{1,16}\.\d{1,12}$' THEN RAISE EXCEPTION 'invalid review root'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,target_day)::text,31));
  SELECT * INTO root_record FROM otl.community_records WHERE team_id=t AND channel_id=c AND
    record_key='common-thread:'||target_day::text||':review' AND kind='prompt';
  SELECT * INTO dispatch FROM otl.community_records WHERE team_id=t AND channel_id=c AND
    record_key='common:'||target_day::text||':review' AND kind='dispatch';
  IF root_record.body->>'date' IS DISTINCT FROM target_day::text OR root_record.body->>'kind' IS DISTINCT FROM 'review'
    OR root_record.body->>'ts' IS DISTINCT FROM root OR dispatch.status IS DISTINCT FROM 'sent'
    OR dispatch.body->>'date' IS DISTINCT FROM target_day::text OR dispatch.body->>'kind' IS DISTINCT FROM 'review'
    OR dispatch.body->>'messageTs' IS DISTINCT FROM root
  THEN RAISE EXCEPTION 'exact sent review root required'; END IF;
  INSERT INTO otl.community_review_roots(team_id,channel_id,day,root_key,thread_ts,bound_by_user_id)
   VALUES(t,c,target_day,'common-thread:'||target_day::text||':review',root,u)
   ON CONFLICT(team_id,channel_id,day) DO NOTHING;
  IF EXISTS(SELECT 1 FROM otl.community_review_roots x WHERE x.team_id=t AND x.channel_id=c
    AND x.day=target_day AND x.thread_ts<>root) THEN RAISE EXCEPTION 'review root already bound'; END IF;
  UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,
    lease_expires_at=NULL,retry_after=NULL,updated_at=transaction_timestamp()
   WHERE team_id=t AND channel_id=c AND day=target_day AND status IN ('pending','claimed','failed')
    AND thread_ts<>root;
  SELECT count(*) INTO before_deliveries FROM otl.community_garden_deliveries
   WHERE team_id=t AND channel_id=c AND day=target_day AND thread_ts=root
    AND route_kind='review_prompt' AND route_provenance='canonical_review';
  FOR row_day IN SELECT * FROM otl.community_days d WHERE d.team_id=t AND d.channel_id=c
    AND d.day=target_day AND (d.outcome<>'pending' OR d.reflection<>'') ORDER BY d.user_id
  LOOP PERFORM otl.enqueue_review_garden(t,c,row_day.user_id,target_day,root); END LOOP;
  SELECT count(*) INTO after_deliveries FROM otl.community_garden_deliveries
   WHERE team_id=t AND channel_id=c AND day=target_day AND thread_ts=root
    AND route_kind='review_prompt' AND route_provenance='canonical_review';
  RETURN jsonb_build_object('date',target_day,'threadTs',root,'enqueued',after_deliveries-before_deliveries);
 END IF;

 IF op='route_review_garden' THEN
  target_day:=(p->>'date')::date;
  root:=otl.enqueue_review_garden(t,c,u,target_day,p->>'sourceTs');
  RETURN CASE WHEN root IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('deliveryKey',root) END;
 END IF;

 IF op='claim_review_reminder_batch' THEN
  IF coalesce(lease,'')='' OR coalesce(p->>'workerId','')='' THEN RAISE EXCEPTION 'lease required'; END IF;
  local_now:=(p->>'now')::timestamptz AT TIME ZONE 'Asia/Seoul'; target_day:=local_now::date;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,target_day,'review')::text,31));
  PERFORM otl.community_execute_before_review_thread('due',p);
  root:=otl.review_root_ts(t,c,target_day);
  IF root IS NULL THEN RETURN 'null'::jsonb; END IF;
  SELECT reminder_batch_key INTO chosen_batch FROM otl.community_records r
   WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder' AND r.body->>'kind'='review'
    AND r.body->>'date'=target_day::text AND r.reminder_attempts<3 AND r.reminder_batch_key IS NOT NULL
    AND ((r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity')<=(p->>'now')::timestamptz)
      OR (r.status='claimed' AND r.reminder_lease_expires_at<=(p->>'now')::timestamptz))
   ORDER BY r.updated_at,r.reminder_batch_key LIMIT 1;
  chosen_batch:=coalesce(chosen_batch,lease);
  WITH candidates AS(
   SELECT r.ctid,row_number() OVER(ORDER BY r.user_id) n,
    sum(length(r.user_id)+4) OVER(ORDER BY r.user_id) chars
   FROM otl.community_records r WHERE r.team_id=t AND r.channel_id=c AND r.kind='reminder'
    AND r.body->>'kind'='review' AND r.body->>'date'=target_day::text AND r.reminder_attempts<3
    AND ((r.reminder_batch_key=chosen_batch AND r.status IN ('failed','claimed')
      AND coalesce(r.reminder_retry_after,r.reminder_lease_expires_at,'-infinity')<=(p->>'now')::timestamptz)
      OR (chosen_batch=lease AND r.status='pending'))
    AND otl.reminder_eligible(t,c,r.user_id,'review',local_now)
  ) UPDATE otl.community_records r SET status='claimed',reminder_attempts=reminder_attempts+1,
    reminder_batch_key=chosen_batch,reminder_first_attempt_at=coalesce(reminder_first_attempt_at,(p->>'now')::timestamptz),
    reminder_lease_token=lease,reminder_lease_expires_at=(p->>'now')::timestamptz+interval '5 minutes',
    reminder_retry_after=NULL,reminder_last_error_code=NULL,body=body||jsonb_build_object('threadTs',root),
    updated_at=(p->>'now')::timestamptz FROM candidates x WHERE r.ctid=x.ctid AND x.n<=100 AND x.chars<=2400;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=0 THEN RETURN 'null'::jsonb; END IF;
  SELECT max(reminder_attempts) INTO attempt FROM otl.community_records WHERE reminder_lease_token=lease;
  RETURN jsonb_build_object('leaseToken',lease,'batchKey',chosen_batch,'attempt',attempt,'date',target_day,
   'kind','review','threadTs',root,'firstAttemptAt',(SELECT min(reminder_first_attempt_at) FROM otl.community_records WHERE reminder_lease_token=lease),
   'jobs',(SELECT jsonb_agg(jsonb_build_object('teamId',r.team_id,'channelId',r.channel_id,'userId',r.user_id,
    'key',r.record_key,'date',r.body->>'date','kind','review') ORDER BY r.user_id)
    FROM otl.community_records r WHERE r.reminder_lease_token=lease));
 END IF;

 IF op='finish_review_reminder_batch' THEN
  IF coalesce(lease,'')='' OR p->>'status' NOT IN ('sent','failed','cancelled') THEN RAISE EXCEPTION 'invalid review batch finish'; END IF;
  IF p->>'status'='sent' THEN
   IF p->>'messageTs'!~'^\d{1,16}\.\d{1,12}$' THEN RAISE EXCEPTION 'review reply receipt required'; END IF;
   UPDATE otl.community_records SET status='sent',body=body||jsonb_build_object('messageTs',p->>'messageTs'),
    reminder_lease_token=NULL,reminder_lease_expires_at=NULL,reminder_retry_after=NULL,reminder_last_error_code=NULL,updated_at=transaction_timestamp()
   WHERE team_id=t AND channel_id=c AND kind='reminder' AND status='claimed' AND reminder_lease_token=lease
    AND body->>'kind'='review' AND body->>'threadTs'=otl.review_root_ts(t,c,(body->>'date')::date);
  ELSIF p->>'status'='cancelled' THEN
   UPDATE otl.community_records SET status='cancelled',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=NULL,updated_at=transaction_timestamp()
   WHERE team_id=t AND channel_id=c AND kind='reminder' AND status='claimed' AND reminder_lease_token=lease AND body->>'kind'='review';
  ELSE
   error_code:=p->>'errorCode';
   IF error_code NOT IN ('rate_limited','transport_error','http_5xx','history_incomplete','terminal_provider_error','batch_too_large')
    THEN RAISE EXCEPTION 'invalid reminder error'; END IF;
   retry_seconds:=least(greatest(coalesce((p->>'retryAfterSeconds')::integer,60),1),3600);
   UPDATE otl.community_records SET status='failed',reminder_lease_token=NULL,reminder_lease_expires_at=NULL,
    reminder_retry_after=CASE WHEN reminder_attempts<3 AND error_code<>'terminal_provider_error' THEN transaction_timestamp()+make_interval(secs=>retry_seconds) END,
    reminder_last_error_code=error_code,updated_at=transaction_timestamp()
   WHERE team_id=t AND channel_id=c AND kind='reminder' AND status='claimed' AND reminder_lease_token=lease AND body->>'kind'='review';
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT; RETURN to_jsonb(affected>0);
 END IF;

 IF op='reconcile_review_thread_gardens' THEN
  through_day:=(p->>'through')::date; from_day:=coalesce((p->>'from')::date,through_day-interval '90 days');
  lim:=least(greatest(coalesce((p->>'limit')::integer,100),1),100); dry:=coalesce((p->>'dryRun')::boolean,true);
  IF through_day<from_day OR length(coalesce(p->>'reconciliationKey','')) NOT BETWEEN 3 AND 100 THEN RAISE EXCEPTION 'invalid reconciliation scope'; END IF;
  request_digest:=md5((p-'dryRun'-'reconciliationKey')::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,c,from_day,through_day)::text,31));
  IF NOT dry THEN
   SELECT * INTO existing FROM otl.community_review_reconciliations WHERE team_id=t AND channel_id=c AND reconciliation_key=p->>'reconciliationKey';
   IF FOUND THEN
    IF existing.request_digest<>request_digest THEN RAISE EXCEPTION 'reconciliation key scope mismatch'; END IF;
    RETURN existing.result||jsonb_build_object('replayed',true,'deliveriesEnqueued',0,'routesCancelled',0,'retirementsHeld',0);
   END IF;
  END IF;
  CREATE TEMP TABLE review_plan ON COMMIT DROP AS
   SELECT d.*,otl.review_root_ts(d.team_id,d.channel_id,d.day) root_ts
   FROM otl.community_days d WHERE d.team_id=t AND d.channel_id=c AND d.day BETWEEN from_day AND through_day
    AND (p->>'userId' IS NULL OR d.user_id=p->>'userId') AND (d.outcome<>'pending' OR d.reflection<>'')
   ORDER BY d.day,d.user_id LIMIT lim;
  SELECT count(*) FILTER(WHERE root_ts IS NOT NULL),count(*) FILTER(WHERE root_ts IS NULL)
   INTO current_count,affected FROM review_plan;
  IF NOT dry THEN
   SELECT count(*) INTO before_deliveries FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c;
   FOR plan_row IN SELECT * FROM review_plan WHERE root_ts IS NOT NULL LOOP
    SELECT count(*) INTO enqueued FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c
      AND user_id=plan_row.user_id AND day=plan_row.day AND status IN ('pending','claimed','failed')
      AND (thread_ts<>plan_row.root_ts OR route_kind<>'review_prompt' OR route_provenance<>'canonical_review');
    cancelled_count:=cancelled_count+enqueued;
    PERFORM otl.enqueue_review_garden(t,c,plan_row.user_id,plan_row.day,plan_row.root_ts);
   END LOOP;
   SELECT count(*) INTO after_deliveries FROM otl.community_garden_deliveries WHERE team_id=t AND channel_id=c;
   INSERT INTO otl.community_garden_retirements(team_id,channel_id,user_id,day,canonical_projection_key,
     old_projection_key,old_message_ts,old_payload)
    SELECT oldp.team_id,oldp.channel_id,oldp.user_id,oldp.day,canonical.projection_key,
      oldp.projection_key,oldd.message_ts,oldd.payload
    FROM otl.community_garden_projections oldp
    JOIN otl.community_garden_deliveries oldd ON oldd.projection_key=oldp.projection_key
      AND oldd.status='sent' AND oldd.message_ts IS NOT NULL AND oldd.payload IS NOT NULL
    JOIN review_plan plan ON plan.team_id=oldp.team_id AND plan.channel_id=oldp.channel_id
      AND plan.user_id=oldp.user_id AND plan.day=oldp.day AND plan.root_ts IS NOT NULL
    JOIN otl.community_garden_projections canonical ON canonical.team_id=oldp.team_id
      AND canonical.channel_id=oldp.channel_id AND canonical.user_id=oldp.user_id
      AND canonical.day=oldp.day AND canonical.thread_ts=plan.root_ts
      AND canonical.route_kind='review_prompt' AND canonical.route_provenance='canonical_review'
    WHERE oldp.projection_key<>canonical.projection_key
    ON CONFLICT(team_id,channel_id,old_message_ts) DO NOTHING;
   GET DIAGNOSTICS retirement_count=ROW_COUNT;
   SELECT count(*) INTO missing_payload FROM otl.community_garden_projections oldp
    JOIN otl.community_garden_deliveries oldd ON oldd.projection_key=oldp.projection_key AND oldd.status='sent' AND oldd.message_ts IS NOT NULL
    JOIN review_plan plan ON plan.team_id=oldp.team_id AND plan.channel_id=oldp.channel_id AND plan.user_id=oldp.user_id AND plan.day=oldp.day AND plan.root_ts IS NOT NULL
    WHERE oldp.thread_ts<>plan.root_ts AND oldd.payload IS NULL;
  ELSE before_deliveries:=0; after_deliveries:=0; END IF;
  result:=jsonb_build_object('canonicalRoutes',current_count,'missingReviewRoots',affected,
    'deliveriesEnqueued',after_deliveries-before_deliveries,'routesCancelled',cancelled_count,
    'retirementsHeld',retirement_count,'missingRestorablePayloads',missing_payload,'dryRun',dry,'replayed',false,
    'planDigest',md5(coalesce((SELECT string_agg(concat_ws(':',user_id,day,revision,root_ts),',' ORDER BY day,user_id) FROM review_plan),'')));
  IF NOT dry THEN INSERT INTO otl.community_review_reconciliations VALUES(t,c,p->>'reconciliationKey',request_digest,result,transaction_timestamp()); END IF;
  RETURN result;
 END IF;

 IF op='claim_review_garden_retirement' THEN
  IF coalesce(lease,'')='' OR coalesce(p->>'workerId','')='' OR coalesce(p->>'now','')=''
   THEN RAISE EXCEPTION 'retirement lease required'; END IF;
  UPDATE otl.community_garden_retirements r SET status='pending',replacement_message_ts=pj.message_ts,updated_at=transaction_timestamp()
   FROM otl.community_garden_projections pj
   WHERE r.team_id=t AND r.channel_id=c AND r.status='held' AND pj.projection_key=r.canonical_projection_key
    AND pj.published_revision=pj.desired_revision AND pj.message_ts IS NOT NULL;
  SELECT * INTO retirement FROM otl.community_garden_retirements r WHERE r.team_id=t AND r.channel_id=c
   AND r.attempts<3 AND (r.status='pending' OR (r.status='failed' AND coalesce(r.retry_after,'-infinity')<=(p->>'now')::timestamptz)
    OR (r.status='claimed' AND r.lease_expires_at<=(p->>'now')::timestamptz))
   ORDER BY r.created_at,r.retirement_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.community_garden_retirements SET status='claimed',attempts=attempts+1,worker_id=p->>'workerId',lease_token=lease,
   lease_expires_at=(p->>'now')::timestamptz+interval '5 minutes',retry_after=NULL,error_code=NULL,updated_at=(p->>'now')::timestamptz
   WHERE retirement_id=retirement.retirement_id RETURNING * INTO retirement;
  RETURN jsonb_build_object('retirementId',retirement.retirement_id,'userId',retirement.user_id,'date',retirement.day,
   'messageTs',retirement.old_message_ts,'replacementMessageTs',retirement.replacement_message_ts,
   'action',retirement.action,'preserveReplies',retirement.preserve_replies,'restorePayload',retirement.old_payload);
 END IF;

 IF op='finish_review_garden_retirement' THEN
  IF coalesce(lease,'')='' OR p->>'status' NOT IN ('retired','failed') THEN RAISE EXCEPTION 'invalid retirement finish'; END IF;
  UPDATE otl.community_garden_retirements SET status=p->>'status',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,
   retry_after=CASE WHEN p->>'status'='failed' AND attempts<3 THEN coalesce((p->>'retryAfter')::timestamptz,transaction_timestamp()+interval '1 minute') END,
   error_code=CASE WHEN p->>'status'='failed' THEN coalesce(p->>'errorCode','provider_error') END,updated_at=transaction_timestamp()
   WHERE team_id=t AND channel_id=c AND retirement_id=(p->>'retirementId')::bigint AND status='claimed' AND lease_token=lease;
  GET DIAGNOSTICS affected=ROW_COUNT; RETURN to_jsonb(affected=1);
 END IF;

 IF op='claim_review_garden_restore' THEN
  IF coalesce(lease,'')='' OR coalesce(p->>'workerId','')='' OR coalesce(p->>'now','')=''
   THEN RAISE EXCEPTION 'restore lease required'; END IF;
  now_at:=(p->>'now')::timestamptz;
  SELECT * INTO retirement FROM otl.community_garden_retirements r
   WHERE r.team_id=t AND r.channel_id=c AND r.retirement_id=(p->>'retirementId')::bigint
    AND (r.status IN ('retired','restore_failed')
      OR (r.status='restore_claimed' AND r.lease_expires_at<=now_at))
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.community_garden_retirements SET status='restore_claimed',worker_id=p->>'workerId',lease_token=lease,
   lease_expires_at=now_at+interval '5 minutes',updated_at=now_at
   WHERE team_id=t AND channel_id=c AND retirement_id=retirement.retirement_id
   RETURNING * INTO retirement;
  RETURN jsonb_build_object('retirementId',retirement.retirement_id,'messageTs',retirement.old_message_ts,
   'action','update','preserveReplies',true,'restorePayload',retirement.old_payload);
 END IF;

 IF op='finish_review_garden_restore' THEN
  IF coalesce(lease,'')='' OR p->>'status' NOT IN ('restored','restore_failed') THEN RAISE EXCEPTION 'invalid restore finish'; END IF;
  UPDATE otl.community_garden_retirements SET status=p->>'status',worker_id=NULL,lease_token=NULL,
   lease_expires_at=NULL,error_code=CASE WHEN p->>'status'='restore_failed' THEN coalesce(p->>'errorCode','provider_error') END,
   updated_at=transaction_timestamp() WHERE team_id=t AND channel_id=c
    AND retirement_id=(p->>'retirementId')::bigint AND status='restore_claimed' AND lease_token=lease;
  GET DIAGNOSTICS affected=ROW_COUNT; RETURN to_jsonb(affected=1);
 END IF;

 RETURN otl.community_execute_before_review_thread(op,p);
END $$;

REVOKE ALL ON TABLE otl.community_review_roots,otl.community_review_reconciliations,
  otl.community_garden_retirements FROM PUBLIC;
REVOKE ALL ON FUNCTION otl.review_root_ts(text,text,date),
  otl.enqueue_review_garden(text,text,text,date,text),otl.community_execute(text,jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('031-review-thread-gardens');
COMMIT;
