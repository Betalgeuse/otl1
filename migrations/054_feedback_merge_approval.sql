BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE otl.git_changes
  ADD COLUMN merge_status text NOT NULL DEFAULT 'awaiting_approval',
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN merge_attempt smallint NOT NULL DEFAULT 0,
  ADD COLUMN merge_worker_id text,
  ADD COLUMN merge_lease_token text,
  ADD COLUMN merge_lease_expires_at timestamptz,
  ADD COLUMN merge_retry_after timestamptz;
UPDATE otl.git_changes SET merge_status=CASE WHEN merged_sha IS NULL THEN 'awaiting_approval' ELSE 'merged' END;
ALTER TABLE otl.git_changes
  ADD CONSTRAINT git_changes_merge_status_check
    CHECK (merge_status IN ('awaiting_approval','approved','claimed','merged','failed')),
  ADD CONSTRAINT git_changes_merge_attempt_check CHECK (merge_attempt BETWEEN 0 AND 3),
  ADD CONSTRAINT git_changes_merge_approval_check
    CHECK ((approved_at IS NULL)=(approved_by IS NULL)),
  ADD CONSTRAINT git_changes_merge_claim_check
    CHECK ((merge_status='claimed')=(merge_worker_id IS NOT NULL AND merge_lease_token IS NOT NULL AND merge_lease_expires_at IS NOT NULL));

ALTER TABLE otl.bug_runner_notifications DROP CONSTRAINT bug_runner_notifications_kind_check;
ALTER TABLE otl.bug_runner_notifications ADD CONSTRAINT bug_runner_notifications_kind_check
  CHECK (kind IN ('task_started','task_ready','task_failed','merge_ready','change_merged'));

CREATE OR REPLACE FUNCTION otl.bug_runner_finish_fix(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; r otl.bug_reports; run otl.agent_runs; finished jsonb; transitioned jsonb;
  admin_id text; packet jsonb; change otl.git_changes;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'runId','')=''
     OR coalesce(p->>'resultDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'artifactDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'headSha','') !~ '^[0-9a-f]{40,64}$'
     OR coalesce(p->>'branch','') !~ '^feedback/[a-z0-9-]{1,120}$'
     OR (p->>'prNumber')::bigint<1 OR length(coalesce(p->>'summary','')) NOT BETWEEN 1 AND 1200
  THEN RAISE EXCEPTION 'invalid fix finish' USING ERRCODE='22023'; END IF;
  SELECT jobs.* INTO j FROM otl.bug_jobs jobs JOIN otl.bug_reports reports ON reports.bug_id=jobs.bug_id
    WHERE jobs.job_id=(p->>'jobId')::bigint AND reports.team_id=p->>'teamId' FOR UPDATE OF jobs;
  IF NOT FOUND OR j.kind<>'fix' OR j.status<>'leased' OR j.worker_id<>p->>'workerId' OR j.lease_token<>p->>'leaseToken'
  THEN RAISE EXCEPTION 'fix lease lost' USING ERRCODE='40001'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=j.bug_id FOR UPDATE;
  SELECT * INTO run FROM otl.agent_runs WHERE run_id=p->>'runId' AND job_id=j.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fix run missing' USING ERRCODE='22023'; END IF;
  UPDATE otl.agent_runs SET exit_class='checks_green',elapsed_ms=(p->>'elapsedMs')::bigint,
    artifact_digest=p->>'artifactDigest' WHERE run_id=run.run_id;
  finished:=otl.bug_finish_job(jsonb_build_object('jobId',j.job_id,'workerId',j.worker_id,
    'leaseToken',j.lease_token,'status','succeeded','resultDigest',p->>'resultDigest'));
  INSERT INTO otl.git_changes(bug_id,branch,commit_sha,pr_number)
    VALUES(j.bug_id,p->>'branch',p->>'headSha',(p->>'prNumber')::bigint)
    RETURNING * INTO change;
  transitioned:=otl.bug_transition(jsonb_build_object(
    'bugId',j.bug_id,'toState','merge_eligible','variant','genquant_green',
    'actors',jsonb_build_array('deterministic_worker'),
    'guard',jsonb_build_object('patchApplies',true,'fullCheckGreen',true,'noForbiddenPaths',true),
    'evidence',jsonb_build_object('branch',p->>'branch','headSha',p->>'headSha',
      'checkReceipt',p->>'resultDigest','prNumber',p->>'prNumber'),
    'expectedRevision',r.revision,'idempotencyKey','runner-fix-green:'||run.run_id));
  SELECT evidence->>'adminId' INTO admin_id FROM otl.bug_events
    WHERE bug_id=r.bug_id AND to_state='queued' ORDER BY event_id LIMIT 1;
  SELECT confirmed_packet INTO packet FROM otl.bug_report_revisions
    WHERE bug_id=r.bug_id AND packet_revision=r.packet_revision;
  INSERT INTO otl.bug_runner_notifications(team_id,bug_id,job_id,run_id,channel_id,thread_ts,kind,payload)
  VALUES(r.team_id,r.bug_id,j.job_id,run.run_id,r.source_channel_id,r.source_thread,'merge_ready',
    jsonb_build_object('taskUrl',run.provider_task_url,'attempt',j.attempt,'reporterId',r.reporter_id,
      'adminId',admin_id,'summary',left(p->>'summary',1200),'prNumber',change.pr_number,
      'prUrl','https://github.com/Betalgeuse/otl1/pull/'||change.pr_number,
      'packetRevision',r.packet_revision,'asIs',packet->'fields'->>'actual','toBe',packet->'fields'->>'expected'))
  ON CONFLICT(run_id,kind) DO NOTHING;
  RETURN jsonb_build_object('job',finished,'transition',transitioned,'change',to_jsonb(change));
END $$;

CREATE FUNCTION otl.bug_admin_approve_merge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; change otl.git_changes;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'bugId','')=''
     OR coalesce(p->>'adminId','')='' OR (p->>'prNumber')::bigint<1
     OR coalesce(p->>'idempotencyKey','')=''
  THEN RAISE EXCEPTION 'invalid merge approval' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND OR r.team_id<>p->>'teamId' OR r.state<>'merge_eligible'
     OR r.packet_revision<>(p->>'packetRevision')::integer
  THEN RAISE EXCEPTION 'merge approval scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO change FROM otl.git_changes
    WHERE bug_id=r.bug_id AND pr_number=(p->>'prNumber')::bigint
    ORDER BY change_id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge change missing' USING ERRCODE='22023'; END IF;
  IF change.merge_status IN ('approved','claimed','merged') THEN
    RETURN jsonb_build_object('accepted',true,'changed',false,'status',change.merge_status,'changeId',change.change_id);
  END IF;
  IF change.merge_status<>'awaiting_approval' THEN
    RETURN jsonb_build_object('accepted',false,'changed',false,'status',change.merge_status);
  END IF;
  UPDATE otl.git_changes SET merge_status='approved',approved_by=p->>'adminId',approved_at=clock_timestamp()
    WHERE change_id=change.change_id RETURNING * INTO change;
  INSERT INTO otl.bug_events(bug_id,idempotency_key,from_state,to_state,variant,revision,actors,guard_code,evidence)
  VALUES(r.bug_id,p->>'idempotencyKey',r.state,r.state,'merge_approval',r.revision,
    jsonb_build_array('admin'),'merge_approved',jsonb_build_object('adminId',p->>'adminId','prNumber',change.pr_number))
  ON CONFLICT(bug_id,idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('accepted',true,'changed',true,'status',change.merge_status,'changeId',change.change_id);
END $$;

CREATE FUNCTION otl.bug_runner_claim_merge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE change otl.git_changes; r otl.bug_reports; run otl.agent_runs;
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')=''
  THEN RAISE EXCEPTION 'invalid merge claim' USING ERRCODE='22023'; END IF;
  UPDATE otl.git_changes SET merge_status=CASE WHEN merge_attempt>=3 THEN 'failed' ELSE 'approved' END,
    merge_worker_id=NULL,merge_lease_token=NULL,merge_lease_expires_at=NULL,
    merge_retry_after=CASE WHEN merge_attempt>=3 THEN NULL ELSE at_time END
  WHERE merge_status='claimed' AND merge_lease_expires_at<at_time;
  SELECT changes.* INTO change FROM otl.git_changes changes
  JOIN otl.bug_reports reports ON reports.bug_id=changes.bug_id
  WHERE reports.team_id=p->>'teamId' AND reports.state='merge_eligible'
    AND changes.merge_status='approved' AND coalesce(changes.merge_retry_after,at_time)<=at_time
  ORDER BY changes.approved_at,changes.change_id FOR UPDATE OF changes SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.git_changes SET merge_status='claimed',merge_attempt=merge_attempt+1,
    merge_worker_id=p->>'workerId',merge_lease_token=p->>'leaseToken',
    merge_lease_expires_at=at_time+interval '5 minutes'
  WHERE change_id=change.change_id RETURNING * INTO change;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=change.bug_id;
  SELECT * INTO run FROM otl.agent_runs WHERE bug_id=r.bug_id AND exit_class='checks_green'
    ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge run missing' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('changeId',change.change_id,'bugId',r.bug_id,'prNumber',change.pr_number,
    'headSha',change.commit_sha,'runId',run.run_id,'leaseToken',change.merge_lease_token,
    'attempt',change.merge_attempt);
END $$;

CREATE FUNCTION otl.bug_runner_fail_merge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE change otl.git_changes; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  UPDATE otl.git_changes SET merge_status=CASE WHEN merge_attempt>=3 THEN 'failed' ELSE 'approved' END,
    merge_retry_after=CASE WHEN merge_attempt>=3 THEN NULL ELSE at_time+interval '60 seconds' END,
    merge_worker_id=NULL,merge_lease_token=NULL,merge_lease_expires_at=NULL
  WHERE change_id=(p->>'changeId')::bigint AND merge_status='claimed'
    AND merge_worker_id=p->>'workerId' AND merge_lease_token=p->>'leaseToken'
  RETURNING * INTO change;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge lease lost' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(change);
END $$;

CREATE OR REPLACE FUNCTION otl.bug_runner_finish_merge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; change otl.git_changes; run otl.agent_runs; transitioned jsonb; admin_id text;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'runId','')=''
     OR coalesce(p->>'mergeSha','') !~ '^[0-9a-f]{40,64}$'
     OR coalesce(p->>'mergeReceipt','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'summary','')='' OR coalesce(p->>'workerId','')='' OR coalesce(p->>'leaseToken','')=''
  THEN RAISE EXCEPTION 'invalid merge finish' USING ERRCODE='22023'; END IF;
  SELECT * INTO change FROM otl.git_changes WHERE change_id=(p->>'changeId')::bigint FOR UPDATE;
  IF NOT FOUND OR change.merge_status<>'claimed' OR change.merge_worker_id<>p->>'workerId'
     OR change.merge_lease_token<>p->>'leaseToken' OR change.commit_sha<>p->>'headSha'
  THEN RAISE EXCEPTION 'merge lease lost' USING ERRCODE='40001'; END IF;
  SELECT * INTO run FROM otl.agent_runs WHERE run_id=p->>'runId' AND bug_id=change.bug_id;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=change.bug_id AND team_id=p->>'teamId' FOR UPDATE;
  IF run.run_id IS NULL OR r.bug_id IS NULL OR r.state<>'merge_eligible'
  THEN RAISE EXCEPTION 'merge state mismatch' USING ERRCODE='40001'; END IF;
  transitioned:=otl.bug_transition(jsonb_build_object(
    'bugId',r.bug_id,'toState','merged','actors',jsonb_build_array('github_webhook'),
    'guard',jsonb_build_object('signedWebhook',true,'sameHead',true),
    'evidence',jsonb_build_object('mergeWebhook',p->>'mergeReceipt','mergeSha',p->>'mergeSha'),
    'expectedRevision',r.revision,'idempotencyKey','runner-merged:'||run.run_id));
  UPDATE otl.git_changes SET merged_sha=p->>'mergeSha',merge_status='merged',
    merge_worker_id=NULL,merge_lease_token=NULL,merge_lease_expires_at=NULL
    WHERE change_id=change.change_id;
  admin_id:=change.approved_by;
  INSERT INTO otl.bug_runner_notifications(team_id,bug_id,job_id,run_id,channel_id,thread_ts,kind,payload)
  VALUES(r.team_id,r.bug_id,run.job_id,run.run_id,r.source_channel_id,r.source_thread,'change_merged',
    jsonb_build_object('taskUrl',run.provider_task_url,'attempt',1,'reporterId',r.reporter_id,
      'adminId',admin_id,'summary',left(p->>'summary',1200)))
  ON CONFLICT(run_id,kind) DO NOTHING;
  RETURN transitioned;
END $$;

REVOKE ALL ON FUNCTION otl.bug_admin_approve_merge(jsonb),otl.bug_runner_claim_merge(jsonb),otl.bug_runner_fail_merge(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION otl.bug_runner_claim_merge(jsonb),otl.bug_runner_fail_merge(jsonb) TO otl_bug_runner;

INSERT INTO otl.schema_migrations(version) VALUES('054-feedback-merge-approval');
COMMIT;
