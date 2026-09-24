BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otl_bug_runner') THEN
    CREATE ROLE otl_bug_runner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

ALTER TABLE otl.agent_runs
  ADD COLUMN provider text,
  ADD COLUMN provider_task_id text,
  ADD COLUMN provider_task_url text;

ALTER TABLE otl.agent_runs
  ADD CONSTRAINT agent_runs_provider_check
  CHECK (provider IS NULL OR provider IN ('codex_cloud_cli')),
  ADD CONSTRAINT agent_runs_provider_task_id_check
  CHECK (provider_task_id IS NULL OR provider_task_id ~ '^task_[a-z]_[a-f0-9]{32}$'),
  ADD CONSTRAINT agent_runs_provider_task_url_check
  CHECK (provider_task_url IS NULL OR provider_task_url ~ '^https://chatgpt[.]com/codex/tasks/task_[a-z]_[a-f0-9]{32}$'),
  ADD CONSTRAINT agent_runs_provider_task_unique UNIQUE(provider,provider_task_id);

CREATE TABLE otl.bug_runner_notifications (
  notification_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES otl.bug_jobs(job_id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES otl.agent_runs(run_id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('task_started','task_ready','task_failed')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','sent','failed')),
  attempt smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token text,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, kind),
  CHECK ((status = 'claimed') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX bug_runner_notifications_due
ON otl.bug_runner_notifications(team_id, status, not_before, notification_id)
WHERE status IN ('pending','failed','claimed');

CREATE FUNCTION otl.bug_admin_queue(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; transitioned jsonb;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'bugId','')=''
     OR coalesce(p->>'reporterId','')='' OR coalesce(p->>'adminId','')=''
     OR coalesce(p->>'baseSha','') !~ '^[0-9a-f]{40,64}$'
     OR coalesce(p->>'approvalReceipt','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'idempotencyKey','')=''
  THEN RAISE EXCEPTION 'invalid admin queue request' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND OR r.team_id<>p->>'teamId' OR r.reporter_id<>p->>'reporterId'
     OR r.packet_revision<>(p->>'packetRevision')::integer
  THEN RAISE EXCEPTION 'admin queue scope mismatch' USING ERRCODE='42501'; END IF;
  IF r.state='queued' THEN
    RETURN jsonb_build_object('accepted',true,'changed',false,'idempotent',true,'state',r.state,'revision',r.revision);
  END IF;
  IF r.state<>'triaged' THEN
    RETURN jsonb_build_object('accepted',false,'reason','confirmed_packet_required','state',r.state,'revision',r.revision);
  END IF;
  transitioned:=otl.bug_transition(jsonb_build_object(
    'bugId',r.bug_id,'toState','queued','actors',jsonb_build_array('admin'),
    'guard',jsonb_build_object('classified',true,'notPaused',true),
    'evidence',jsonb_build_object('triageReceipt',p->>'approvalReceipt','baseSha',p->>'baseSha','adminId',p->>'adminId'),
    'expectedRevision',r.revision,'idempotencyKey',p->>'idempotencyKey','now',coalesce(p->>'now',clock_timestamp()::text)
  ));
  RETURN transitioned || jsonb_build_object('accepted',true);
END $$;

CREATE FUNCTION otl.bug_runner_lease(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE
  j otl.bug_jobs;
  r otl.bug_reports;
  rev otl.bug_report_revisions;
  base_sha text;
  transition_result jsonb;
  at_time timestamptz := coalesce((p->>'now')::timestamptz, clock_timestamp());
  lease_seconds integer := coalesce((p->>'leaseSeconds')::integer, 900);
BEGIN
  IF coalesce(p->>'teamId','') = ''
     OR coalesce(p->>'workerId','') = ''
     OR coalesce(p->>'accountAlias','') = ''
     OR coalesce(p->>'leaseToken','') = ''
     OR coalesce(p->>'runnerImageDigest','') !~ '^[0-9a-f]{64}$'
     OR lease_seconds NOT BETWEEN 60 AND 1800
  THEN RAISE EXCEPTION 'invalid runner lease' USING ERRCODE = '22023'; END IF;

  SELECT jobs.* INTO j
  FROM otl.bug_jobs jobs
  JOIN otl.bug_reports reports ON reports.bug_id = jobs.bug_id
  WHERE reports.team_id = p->>'teamId'
    AND jobs.status = 'leased'
    AND jobs.worker_id = p->>'workerId'
    AND jobs.lease_token = p->>'leaseToken';
  IF FOUND THEN
    SELECT * INTO r FROM otl.bug_reports WHERE bug_id = j.bug_id;
    SELECT * INTO rev FROM otl.bug_report_revisions
      WHERE bug_id = r.bug_id AND packet_revision = r.packet_revision;
    SELECT evidence->>'baseSha' INTO base_sha FROM otl.bug_events WHERE event_id=j.event_id;
    RETURN jsonb_build_object(
      'job', to_jsonb(j),
      'bug', jsonb_build_object(
        'teamId', r.team_id, 'bugId', r.bug_id, 'publicAlias', r.public_alias,
        'state', r.state, 'revision', r.revision, 'packetRevision', r.packet_revision,
        'confirmedPacket', rev.confirmed_packet, 'baseSha', base_sha,
        'sourceChannelId', r.source_channel_id, 'sourceThread', r.source_thread
      )
    );
  END IF;

  UPDATE otl.bug_jobs jobs SET
    status = CASE WHEN jobs.attempt >= 3 THEN 'failed' ELSE 'queued' END,
    finished_at = CASE WHEN jobs.attempt >= 3 THEN at_time END,
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = at_time
  FROM otl.bug_reports reports
  WHERE reports.bug_id = jobs.bug_id
    AND reports.team_id = p->>'teamId'
    AND jobs.status = 'leased' AND jobs.lease_expires_at < at_time;

  FOR r IN
    SELECT reports.* FROM otl.bug_reports reports
    JOIN otl.bug_jobs jobs ON jobs.bug_id=reports.bug_id
    WHERE reports.team_id=p->>'teamId' AND reports.state='reproducing'
      AND jobs.kind='reproduce' AND jobs.status='failed' AND jobs.attempt>=3
  LOOP
    PERFORM otl.bug_transition(jsonb_build_object(
      'bugId',r.bug_id,'toState','reproduce_failed','actors',jsonb_build_array('deterministic_worker'),
      'guard',jsonb_build_object('attemptsExhausted',true),
      'evidence',jsonb_build_object('attemptReceipts',jsonb_build_array('lease_expired')),
      'expectedRevision',r.revision,'idempotencyKey','runner-expired:'||r.bug_id,'now',at_time
    ));
  END LOOP;

  SELECT jobs.* INTO j
  FROM otl.bug_jobs jobs
  JOIN otl.bug_reports reports ON reports.bug_id = jobs.bug_id
  JOIN otl.bug_report_revisions revisions
    ON revisions.bug_id = reports.bug_id AND revisions.packet_revision = reports.packet_revision
  WHERE reports.team_id = p->>'teamId'
    AND reports.state IN ('queued','reproducing')
    AND jobs.status = 'queued'
    AND jobs.kind = 'reproduce'
    AND jobs.available_at <= at_time
    AND revisions.confirmed_packet IS NOT NULL
    AND (jobs.assigned_alias IS NULL OR jobs.assigned_alias = p->>'accountAlias')
  ORDER BY jobs.priority, jobs.available_at, jobs.job_id
  FOR UPDATE OF jobs SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;

  UPDATE otl.bug_jobs SET
    status = 'leased', worker_id = p->>'workerId', assigned_alias = p->>'accountAlias',
    lease_token = p->>'leaseToken', lease_expires_at = at_time + make_interval(secs => lease_seconds),
    heartbeat_at = at_time, attempt = attempt + 1, updated_at = at_time
  WHERE job_id = j.job_id RETURNING * INTO j;

  SELECT * INTO r FROM otl.bug_reports WHERE bug_id = j.bug_id FOR UPDATE;
  IF r.state='queued' THEN
    transition_result := otl.bug_transition(jsonb_build_object(
      'bugId', r.bug_id, 'toState', 'reproducing',
      'actors', jsonb_build_array('deterministic_worker'),
      'guard', jsonb_build_object('leaseAcquired', true, 'baseShaCurrent', true),
      'evidence', jsonb_build_object('leaseId', j.lease_token, 'runnerImageDigest', p->>'runnerImageDigest'),
      'expectedRevision', r.revision,
      'idempotencyKey', 'runner-lease:' || j.job_id::text || ':' || j.attempt::text,
      'now', at_time
    ));
  ELSE
    transition_result:=jsonb_build_object('changed',false,'idempotent',true,'state',r.state,'revision',r.revision);
  END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id = j.bug_id;
  SELECT * INTO rev FROM otl.bug_report_revisions
    WHERE bug_id = r.bug_id AND packet_revision = r.packet_revision;
  SELECT evidence->>'baseSha' INTO base_sha FROM otl.bug_events WHERE event_id=j.event_id;
  RETURN jsonb_build_object(
    'job', to_jsonb(j), 'transition', transition_result,
    'bug', jsonb_build_object(
      'teamId', r.team_id, 'bugId', r.bug_id, 'publicAlias', r.public_alias,
      'state', r.state, 'revision', r.revision, 'packetRevision', r.packet_revision,
      'confirmedPacket', rev.confirmed_packet, 'baseSha', base_sha,
      'sourceChannelId', r.source_channel_id, 'sourceThread', r.source_thread
    )
  );
END $$;

CREATE FUNCTION otl.bug_runner_start(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE j otl.bug_jobs; r otl.bug_reports; run otl.agent_runs;
BEGIN
  IF coalesce(p->>'teamId','') = '' OR coalesce(p->>'runId','') = ''
     OR coalesce(p->>'baseSha','') !~ '^[0-9a-f]{40,64}$'
     OR coalesce(p->>'promptDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'providerTaskId','') !~ '^task_[a-z]_[a-f0-9]{32}$'
     OR coalesce(p->>'providerTaskUrl','') !~ '^https://chatgpt[.]com/codex/tasks/task_[a-z]_[a-f0-9]{32}$'
  THEN RAISE EXCEPTION 'invalid runner start' USING ERRCODE = '22023'; END IF;
  SELECT jobs.* INTO j FROM otl.bug_jobs jobs JOIN otl.bug_reports reports ON reports.bug_id=jobs.bug_id
  WHERE jobs.job_id=(p->>'jobId')::bigint AND reports.team_id=p->>'teamId' FOR UPDATE OF jobs;
  IF NOT FOUND OR j.status<>'leased' OR j.worker_id<>p->>'workerId' OR j.lease_token<>p->>'leaseToken'
  THEN RAISE EXCEPTION 'runner lease lost' USING ERRCODE='40001'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=j.bug_id;
  INSERT INTO otl.agent_runs(run_id,bug_id,job_id,account_alias,base_sha,prompt_digest,provider,provider_task_id,provider_task_url)
  VALUES(p->>'runId',j.bug_id,j.job_id,j.assigned_alias,p->>'baseSha',p->>'promptDigest','codex_cloud_cli',p->>'providerTaskId',p->>'providerTaskUrl')
  ON CONFLICT(run_id) DO NOTHING RETURNING * INTO run;
  IF NOT FOUND THEN
    SELECT * INTO run FROM otl.agent_runs WHERE run_id=p->>'runId';
    IF run.bug_id<>j.bug_id OR run.job_id<>j.job_id OR run.base_sha<>p->>'baseSha'
       OR run.prompt_digest<>p->>'promptDigest' OR run.provider_task_id<>p->>'providerTaskId'
       OR run.provider_task_url<>p->>'providerTaskUrl'
    THEN RAISE EXCEPTION 'runner start idempotency mismatch' USING ERRCODE='22023'; END IF;
  END IF;
  INSERT INTO otl.bug_runner_notifications(team_id,bug_id,job_id,run_id,channel_id,thread_ts,kind,payload)
  VALUES(r.team_id,r.bug_id,j.job_id,run.run_id,r.source_channel_id,r.source_thread,'task_started',
    jsonb_build_object('taskUrl',run.provider_task_url,'attempt',j.attempt))
  ON CONFLICT(run_id,kind) DO NOTHING;
  RETURN jsonb_build_object('runId',run.run_id,'bugId',run.bug_id,'jobId',run.job_id);
END $$;

CREATE FUNCTION otl.bug_runner_heartbeat(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE j otl.bug_jobs; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,900);
BEGIN
  IF lease_seconds NOT BETWEEN 60 AND 1800 THEN RAISE EXCEPTION 'invalid heartbeat' USING ERRCODE='22023'; END IF;
  UPDATE otl.bug_jobs jobs SET heartbeat_at=at_time,lease_expires_at=at_time+make_interval(secs=>lease_seconds),updated_at=at_time
  FROM otl.bug_reports reports
  WHERE jobs.job_id=(p->>'jobId')::bigint AND reports.bug_id=jobs.bug_id AND reports.team_id=p->>'teamId'
    AND jobs.status='leased' AND jobs.worker_id=p->>'workerId' AND jobs.lease_token=p->>'leaseToken' AND jobs.lease_expires_at>=at_time
  RETURNING jobs.* INTO j;
  IF NOT FOUND THEN RAISE EXCEPTION 'runner lease lost' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_runner_finish(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE j otl.bug_jobs; r otl.bug_reports; run otl.agent_runs; finished jsonb; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  IF p->>'status' NOT IN ('succeeded','failed') OR coalesce(p->>'resultDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'artifactDigest','') !~ '^[0-9a-f]{64}$' OR coalesce(p->>'runId','')=''
  THEN RAISE EXCEPTION 'invalid runner finish' USING ERRCODE='22023'; END IF;
  SELECT jobs.* INTO j FROM otl.bug_jobs jobs JOIN otl.bug_reports reports ON reports.bug_id=jobs.bug_id
  WHERE jobs.job_id=(p->>'jobId')::bigint AND reports.team_id=p->>'teamId' FOR UPDATE OF jobs;
  IF NOT FOUND OR j.status<>'leased' OR j.worker_id<>p->>'workerId' OR j.lease_token<>p->>'leaseToken'
  THEN RAISE EXCEPTION 'runner lease lost' USING ERRCODE='40001'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=j.bug_id FOR UPDATE;
  SELECT * INTO run FROM otl.agent_runs WHERE run_id=p->>'runId' AND job_id=j.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'runner run missing' USING ERRCODE='22023'; END IF;
  IF p->>'status'='failed' AND j.attempt<3 THEN
    RAISE EXCEPTION 'retryable runner failure keeps lease' USING ERRCODE='40001';
  END IF;
  UPDATE otl.agent_runs SET exit_class=p->>'exitClass',elapsed_ms=(p->>'elapsedMs')::bigint,artifact_digest=p->>'artifactDigest'
  WHERE run_id=run.run_id RETURNING * INTO run;
  finished:=otl.bug_finish_job(jsonb_build_object('jobId',j.job_id,'workerId',j.worker_id,'leaseToken',j.lease_token,'status',p->>'status','resultDigest',p->>'resultDigest','now',at_time));
  IF p->>'status'='succeeded' THEN
    PERFORM otl.bug_transition(jsonb_build_object(
      'bugId',j.bug_id,'toState','reproduced','actors',jsonb_build_array('deterministic_worker'),
      'guard',jsonb_build_object('failureObserved',true),
      'evidence',jsonb_build_object('failingArtifact',p->>'artifactDigest','commandReceipt',p->>'resultDigest'),
      'expectedRevision',r.revision,'idempotencyKey','runner-reproduced:'||run.run_id,'now',at_time
    ));
  ELSE
    PERFORM otl.bug_transition(jsonb_build_object(
      'bugId',j.bug_id,'toState','reproduce_failed','actors',jsonb_build_array('deterministic_worker'),
      'guard',jsonb_build_object('attemptsExhausted',true),
      'evidence',jsonb_build_object('attemptReceipts',jsonb_build_array(p->>'resultDigest')),
      'expectedRevision',r.revision,'idempotencyKey','runner-failed:'||run.run_id,'now',at_time
    ));
  END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=j.bug_id;
  INSERT INTO otl.bug_runner_notifications(team_id,bug_id,job_id,run_id,channel_id,thread_ts,kind,payload)
  VALUES(r.team_id,r.bug_id,j.job_id,run.run_id,r.source_channel_id,r.source_thread,
    CASE WHEN p->>'status'='succeeded' THEN 'task_ready' ELSE 'task_failed' END,
    jsonb_build_object('taskUrl',run.provider_task_url,'attempt',j.attempt,'exitClass',p->>'exitClass'))
  ON CONFLICT(run_id,kind) DO NOTHING;
  RETURN jsonb_build_object('job',finished,'runId',run.run_id);
END $$;

CREATE FUNCTION otl.bug_runner_claim_notifications(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE rows jsonb; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'leaseToken','')='' THEN RAISE EXCEPTION 'invalid notification claim' USING ERRCODE='22023'; END IF;
  WITH due AS (
    SELECT notification_id FROM otl.bug_runner_notifications
    WHERE team_id=p->>'teamId' AND attempt<3
      AND ((status='pending' AND not_before<=at_time) OR (status='failed' AND retry_after<=at_time) OR (status='claimed' AND lease_expires_at<at_time))
    ORDER BY notification_id FOR UPDATE SKIP LOCKED LIMIT least(greatest(coalesce((p->>'limit')::integer,10),1),10)
  ), claimed AS (
    UPDATE otl.bug_runner_notifications n SET status='claimed',attempt=n.attempt+1,lease_token=p->>'leaseToken',lease_expires_at=at_time+interval '60 seconds',updated_at=at_time
    FROM due WHERE n.notification_id=due.notification_id RETURNING n.*
  ) SELECT coalesce(jsonb_agg(to_jsonb(claimed) ORDER BY notification_id),'[]'::jsonb) INTO rows FROM claimed;
  RETURN rows;
END $$;

CREATE FUNCTION otl.bug_runner_finish_notification(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, otl AS $$
DECLARE n otl.bug_runner_notifications; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  IF p->>'status' NOT IN ('sent','failed') THEN RAISE EXCEPTION 'invalid notification finish' USING ERRCODE='22023'; END IF;
  UPDATE otl.bug_runner_notifications SET status=p->>'status',sent_at=CASE WHEN p->>'status'='sent' THEN at_time END,
    retry_after=CASE WHEN p->>'status'='failed' THEN at_time+make_interval(secs=>least(300,(15*power(2,greatest(attempt-1,0)))::integer)) END,
    lease_token=NULL,lease_expires_at=NULL,updated_at=at_time
  WHERE notification_id=(p->>'notificationId')::bigint AND status='claimed' AND lease_token=p->>'leaseToken'
  RETURNING * INTO n;
  IF NOT FOUND THEN RAISE EXCEPTION 'notification lease lost' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(n);
END $$;

REVOKE ALL ON TABLE otl.agent_runs,otl.bug_runner_notifications FROM PUBLIC,otl_bug_runner;
REVOKE ALL ON FUNCTION otl.bug_admin_queue(jsonb),otl.bug_runner_lease(jsonb),otl.bug_runner_start(jsonb),otl.bug_runner_heartbeat(jsonb),otl.bug_runner_finish(jsonb),otl.bug_runner_claim_notifications(jsonb),otl.bug_runner_finish_notification(jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA otl TO otl_bug_runner;
GRANT EXECUTE ON FUNCTION otl.bug_runner_lease(jsonb),otl.bug_runner_start(jsonb),otl.bug_runner_heartbeat(jsonb),otl.bug_runner_finish(jsonb) TO otl_bug_runner;

INSERT INTO otl.schema_migrations(version) VALUES('049-bug-runner-handoff');
COMMIT;
