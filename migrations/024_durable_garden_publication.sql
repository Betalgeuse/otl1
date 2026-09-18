BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:durable-garden-publication:024',0));

CREATE TABLE otl.community_garden_deliveries (
  team_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  delivery_key text NOT NULL,
  day date NOT NULL,
  day_revision integer NOT NULL CHECK(day_revision > 0),
  source_ts text NOT NULL,
  thread_ts text NOT NULL,
  undo_key text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','sent','failed','cancelled')),
  attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  error_code text,
  payload_digest text CHECK(payload_digest IS NULL OR payload_digest ~ '^[0-9a-f]{64}$'),
  message_ts text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id,channel_id,user_id,delivery_key),
  UNIQUE(team_id,channel_id,user_id,day,day_revision),
  CHECK((status='claimed') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND worker_id IS NOT NULL))
);
CREATE INDEX community_garden_due_idx ON otl.community_garden_deliveries(team_id,channel_id,status,retry_after,updated_at)
 WHERE status IN ('pending','claimed','failed');

CREATE FUNCTION otl.community_garden_delivery_json(d otl.community_garden_deliveries)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,otl AS $$
 SELECT jsonb_build_object(
  'teamId',d.team_id,'channelId',d.channel_id,'userId',d.user_id,
  'deliveryKey',d.delivery_key,'date',d.day::text,'revision',d.day_revision,
  'source',d.source_ts,'thread',d.thread_ts,'undoKey',d.undo_key,
  'status',d.status,'attempts',d.attempts,'leaseToken',d.lease_token,
  'payloadDigest',d.payload_digest,'messageTs',d.message_ts)
$$;
REVOKE ALL ON FUNCTION otl.community_garden_delivery_json(otl.community_garden_deliveries) FROM PUBLIC;

ALTER FUNCTION otl.community_execute(text,jsonb) RENAME TO community_execute_before_garden;
REVOKE EXECUTE ON FUNCTION otl.community_execute_before_garden(text,jsonb) FROM PUBLIC;
CREATE FUNCTION otl.community_execute(op text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
 t text:=p->>'teamId'; c text:=p->>'channelId'; u text:=p->>'userId'; k text:=p->>'deliveryKey';
 result jsonb; delivery jsonb; gd otl.community_garden_deliveries; affected integer;
 lease text:=p->>'leaseToken'; now_at timestamptz; retry_at timestamptz; code text:=p->>'errorCode';
BEGIN
 IF coalesce(t,'')='' OR coalesce(c,'')='' THEN RAISE EXCEPTION 'scope required'; END IF;
 IF op='change' THEN
  result:=otl.community_execute_before_garden(op,p);
  IF coalesce((result->>'changed')::boolean,false) AND NOT coalesce((result->>'conflict')::boolean,false) AND p ? 'delivery' THEN
   delivery:=p->'delivery';
   IF coalesce(delivery->>'source','')='' OR coalesce(delivery->>'thread','')='' THEN RAISE EXCEPTION 'garden delivery route required'; END IF;
   k:=format('garden:%s:r%s',result#>>'{day,date}',result#>>'{day,revision}');
   UPDATE otl.community_garden_deliveries SET status='cancelled',updated_at=now()
    WHERE team_id=t AND channel_id=c AND user_id=u AND status IN ('pending','failed');
   INSERT INTO otl.community_garden_deliveries(
    team_id,channel_id,user_id,delivery_key,day,day_revision,source_ts,thread_ts,undo_key)
   VALUES(t,c,u,k,(result#>>'{day,date}')::date,(result#>>'{day,revision}')::integer,
    delivery->>'source',delivery->>'thread',CASE WHEN coalesce((p->>'preserveOutcome')::boolean,false) OR p->>'action'='undo' THEN NULL ELSE 'undo:'||(result->>'undoKey') END)
   ON CONFLICT(team_id,channel_id,user_id,day,day_revision) DO NOTHING;
   RETURN result || jsonb_build_object('gardenDeliveryKey',k);
  END IF;
  RETURN result;
 END IF;
 IF op='claim_garden_delivery' THEN
  IF coalesce(lease,'')='' OR coalesce(p->>'now','')='' THEN RAISE EXCEPTION 'garden lease required'; END IF;
  now_at:=(p->>'now')::timestamptz;
  SELECT * INTO gd FROM otl.community_garden_deliveries d
   WHERE d.team_id=t AND d.channel_id=c AND d.attempts<3
   AND (k IS NULL OR d.delivery_key=k)
   AND (d.status='pending'
    OR (d.status='failed' AND coalesce(d.retry_after,'-infinity'::timestamptz)<=now_at)
    OR (d.status='claimed' AND d.lease_expires_at<=now_at))
   ORDER BY d.created_at,d.delivery_key FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.community_garden_deliveries SET status='claimed',attempts=attempts+1,
   worker_id='garden-publication.v1',lease_token=lease,lease_expires_at=now_at+interval '5 minutes',
   retry_after=NULL,error_code=NULL,updated_at=now_at
   WHERE team_id=gd.team_id AND channel_id=gd.channel_id AND user_id=gd.user_id AND delivery_key=gd.delivery_key
   RETURNING * INTO gd;
  RETURN otl.community_garden_delivery_json(gd);
 END IF;
 IF op='prepare_garden_delivery' THEN
  IF coalesce(u,'')='' OR coalesce(k,'')='' OR coalesce(lease,'')='' OR coalesce(p->>'payloadDigest','') !~ '^[0-9a-f]{64}$'
   THEN RAISE EXCEPTION 'invalid garden payload'; END IF;
  UPDATE otl.community_garden_deliveries SET payload_digest=coalesce(payload_digest,p->>'payloadDigest'),updated_at=now()
   WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k AND status='claimed' AND lease_token=lease;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN to_jsonb(affected=1);
 END IF;
 IF op='finish_garden_delivery' THEN
  IF coalesce(u,'')='' OR coalesce(k,'')='' OR coalesce(lease,'')='' OR p->>'status' NOT IN ('sent','failed','cancelled')
   THEN RAISE EXCEPTION 'invalid garden finish'; END IF;
  IF p->>'status'='sent' THEN
   IF coalesce(p->>'messageTs','')='' THEN RAISE EXCEPTION 'garden message receipt required'; END IF;
   UPDATE otl.community_garden_deliveries SET status='sent',message_ts=p->>'messageTs',worker_id=NULL,
    lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,error_code=NULL,updated_at=now()
    WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k AND status='claimed' AND lease_token=lease;
  ELSIF p->>'status'='cancelled' THEN
   UPDATE otl.community_garden_deliveries SET status='cancelled',worker_id=NULL,lease_token=NULL,
    lease_expires_at=NULL,retry_after=NULL,updated_at=now()
    WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k AND status='claimed' AND lease_token=lease;
  ELSE
   IF code NOT IN ('rate_limited','transport_error','provider_error','internal_error') THEN RAISE EXCEPTION 'invalid garden error'; END IF;
   retry_at:=CASE WHEN (p->>'retryAfter') IS NULL THEN NULL ELSE (p->>'retryAfter')::timestamptz END;
   UPDATE otl.community_garden_deliveries SET status='failed',worker_id=NULL,lease_token=NULL,
    lease_expires_at=NULL,retry_after=CASE WHEN attempts<3 THEN retry_at END,error_code=code,updated_at=now()
    WHERE team_id=t AND channel_id=c AND user_id=u AND delivery_key=k AND status='claimed' AND lease_token=lease;
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN to_jsonb(affected=1);
 END IF;
 RETURN otl.community_execute_before_garden(op,p);
END $$;
REVOKE ALL ON FUNCTION otl.community_execute(text,jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('024-durable-garden-publication');
COMMIT;
