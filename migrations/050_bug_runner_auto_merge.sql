BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE otl.bug_runner_notifications DROP CONSTRAINT bug_runner_notifications_kind_check;
ALTER TABLE otl.bug_runner_notifications ADD CONSTRAINT bug_runner_notifications_kind_check
CHECK (kind IN ('task_started','task_ready','task_failed','change_merged'));

INSERT INTO otl.bug_transition_contract(
  from_state,to_state,variant,actor_requirements,guard_code,required_guard_keys,
  required_evidence_keys,side_effect,resume_state
) VALUES(
  'fixing','merge_eligible','genquant_green','[["deterministic_worker"]]',
  'genquant_green',ARRAY['patchApplies','fullCheckGreen','noForbiddenPaths'],
  ARRAY['branch','headSha','checkReceipt','prNumber'],'policy_check',NULL
) ON CONFLICT DO NOTHING;

CREATE FUNCTION otl.bug_runner_lease_fix(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; r otl.bug_reports; rev otl.bug_report_revisions; base_sha text;
  artifact_digest text; transition_result jsonb;
  at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
  lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,1800);
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'workerId','')=''
     OR coalesce(p->>'accountAlias','')='' OR coalesce(p->>'leaseToken','')=''
     OR coalesce(p->>'runnerImageDigest','') !~ '^[0-9a-f]{64}$'
     OR lease_seconds NOT BETWEEN 60 AND 1800
  THEN RAISE EXCEPTION 'invalid fix lease' USING ERRCODE='22023'; END IF;
  UPDATE otl.bug_jobs jobs SET status=CASE WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,
    finished_at=CASE WHEN attempt>=3 THEN at_time END,worker_id=NULL,lease_token=NULL,
    lease_expires_at=NULL,updated_at=at_time
  FROM otl.bug_reports reports WHERE reports.bug_id=jobs.bug_id
    AND reports.team_id=p->>'teamId' AND jobs.kind='fix' AND jobs.status='leased'
    AND jobs.lease_expires_at<at_time;
  SELECT jobs.* INTO j FROM otl.bug_jobs jobs JOIN otl.bug_reports reports ON reports.bug_id=jobs.bug_id
  JOIN otl.bug_report_revisions revisions ON revisions.bug_id=reports.bug_id AND revisions.packet_revision=reports.packet_revision
  WHERE reports.team_id=p->>'teamId' AND reports.state IN ('reproduced','fixing')
    AND jobs.kind='fix' AND jobs.status='queued' AND jobs.available_at<=at_time
    AND revisions.confirmed_packet IS NOT NULL
    AND (jobs.assigned_alias IS NULL OR jobs.assigned_alias=p->>'accountAlias')
  ORDER BY jobs.priority,jobs.available_at,jobs.job_id FOR UPDATE OF jobs SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.bug_jobs SET status='leased',worker_id=p->>'workerId',assigned_alias=p->>'accountAlias',
    lease_token=p->>'leaseToken',lease_expires_at=at_time+make_interval(secs=>lease_seconds),
    heartbeat_at=at_time,attempt=attempt+1,updated_at=at_time
  WHERE job_id=j.job_id RETURNING * INTO j;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=j.bug_id FOR UPDATE;
  SELECT artifact_digest INTO artifact_digest FROM otl.agent_runs
    WHERE bug_id=r.bug_id AND exit_class='reproduced' AND artifact_digest IS NOT NULL
    ORDER BY created_at DESC LIMIT 1;
  IF artifact_digest IS NULL THEN RAISE EXCEPTION 'reproduction artifact missing' USING ERRCODE='23514'; END IF;
  IF r.state='reproduced' THEN
    transition_result:=otl.bug_transition(jsonb_build_object(
      'bugId',r.bug_id,'toState','fixing','actors',jsonb_build_array('deterministic_worker'),
      'guard',jsonb_build_object('fixLease',true,'artifactImmutable',true),
      'evidence',jsonb_build_object('failingArtifactDigest',artifact_digest),
      'expectedRevision',r.revision,'idempotencyKey','runner-fix-lease:'||j.job_id||':'||j.attempt,'now',at_time));
  ELSE transition_result:=jsonb_build_object('changed',false,'idempotent',true,'state',r.state,'revision',r.revision); END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=j.bug_id;
  SELECT * INTO rev FROM otl.bug_report_revisions WHERE bug_id=r.bug_id AND packet_revision=r.packet_revision;
  SELECT evidence->>'baseSha' INTO base_sha FROM otl.bug_events
    WHERE bug_id=r.bug_id AND to_state='queued' ORDER BY event_id LIMIT 1;
  RETURN jsonb_build_object('job',to_jsonb(j),'transition',transition_result,'bug',jsonb_build_object(
    'teamId',r.team_id,'bugId',r.bug_id,'publicAlias',r.public_alias,'state',r.state,
    'revision',r.revision,'packetRevision',r.packet_revision,'confirmedPacket',rev.confirmed_packet,
    'baseSha',base_sha,'sourceChannelId',r.source_channel_id,'sourceThread',r.source_thread));
END $$;

CREATE FUNCTION otl.bug_runner_finish_fix(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; r otl.bug_reports; run otl.agent_runs; finished jsonb; transitioned jsonb;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'runId','')=''
     OR coalesce(p->>'resultDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'artifactDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'headSha','') !~ '^[0-9a-f]{40,64}$'
     OR coalesce(p->>'branch','') !~ '^feedback/[a-z0-9-]{1,120}$'
     OR (p->>'prNumber')::bigint<1
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
    VALUES(j.bug_id,p->>'branch',p->>'headSha',(p->>'prNumber')::bigint);
  transitioned:=otl.bug_transition(jsonb_build_object(
    'bugId',j.bug_id,'toState','merge_eligible','variant','genquant_green',
    'actors',jsonb_build_array('deterministic_worker'),
    'guard',jsonb_build_object('patchApplies',true,'fullCheckGreen',true,'noForbiddenPaths',true),
    'evidence',jsonb_build_object('branch',p->>'branch','headSha',p->>'headSha',
      'checkReceipt',p->>'resultDigest','prNumber',p->>'prNumber'),
    'expectedRevision',r.revision,'idempotencyKey','runner-fix-green:'||run.run_id));
  RETURN jsonb_build_object('job',finished,'transition',transitioned);
END $$;

CREATE FUNCTION otl.bug_runner_finish_merge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; change otl.git_changes; run otl.agent_runs; transitioned jsonb; admin_id text;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'runId','')=''
     OR coalesce(p->>'mergeSha','') !~ '^[0-9a-f]{40,64}$'
     OR coalesce(p->>'mergeReceipt','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'summary','')=''
  THEN RAISE EXCEPTION 'invalid merge finish' USING ERRCODE='22023'; END IF;
  SELECT * INTO run FROM otl.agent_runs WHERE run_id=p->>'runId';
  SELECT reports.* INTO r FROM otl.bug_reports reports WHERE reports.bug_id=run.bug_id
    AND reports.team_id=p->>'teamId' FOR UPDATE;
  IF NOT FOUND OR r.state<>'merge_eligible' THEN RAISE EXCEPTION 'merge state mismatch' USING ERRCODE='40001'; END IF;
  SELECT * INTO change FROM otl.git_changes WHERE bug_id=r.bug_id AND commit_sha=p->>'headSha'
    ORDER BY change_id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'git change missing' USING ERRCODE='22023'; END IF;
  transitioned:=otl.bug_transition(jsonb_build_object(
    'bugId',r.bug_id,'toState','merged','actors',jsonb_build_array('github_webhook'),
    'guard',jsonb_build_object('signedWebhook',true,'sameHead',true),
    'evidence',jsonb_build_object('mergeWebhook',p->>'mergeReceipt','mergeSha',p->>'mergeSha'),
    'expectedRevision',r.revision,'idempotencyKey','runner-merged:'||run.run_id));
  UPDATE otl.git_changes SET merged_sha=p->>'mergeSha' WHERE change_id=change.change_id;
  SELECT evidence->>'adminId' INTO admin_id FROM otl.bug_events
    WHERE bug_id=r.bug_id AND to_state='queued' ORDER BY event_id LIMIT 1;
  INSERT INTO otl.bug_runner_notifications(team_id,bug_id,job_id,run_id,channel_id,thread_ts,kind,payload)
  VALUES(r.team_id,r.bug_id,run.job_id,run.run_id,r.source_channel_id,r.source_thread,'change_merged',
    jsonb_build_object('taskUrl',run.provider_task_url,'attempt',1,'reporterId',r.reporter_id,
      'adminId',admin_id,'summary',left(p->>'summary',1200)))
  ON CONFLICT(run_id,kind) DO NOTHING;
  RETURN transitioned;
END $$;

REVOKE ALL ON FUNCTION otl.bug_runner_lease_fix(jsonb),otl.bug_runner_finish_fix(jsonb),otl.bug_runner_finish_merge(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION otl.bug_runner_lease_fix(jsonb),otl.bug_runner_finish_fix(jsonb),otl.bug_runner_finish_merge(jsonb) TO otl_bug_runner;
INSERT INTO otl.schema_migrations(version) VALUES('050-bug-runner-auto-merge');
COMMIT;
