BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION otl.bug_runner_lease_fix(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; r otl.bug_reports; rev otl.bug_report_revisions; base_sha text;
  reproduction_digest text; transition_result jsonb;
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
  SELECT runs.artifact_digest INTO reproduction_digest FROM otl.agent_runs runs
    WHERE bug_id=r.bug_id AND runs.exit_class='reproduced' AND runs.artifact_digest IS NOT NULL
    ORDER BY runs.created_at DESC LIMIT 1;
  IF reproduction_digest IS NULL THEN RAISE EXCEPTION 'reproduction artifact missing' USING ERRCODE='23514'; END IF;
  IF r.state='reproduced' THEN
    transition_result:=otl.bug_transition(jsonb_build_object(
      'bugId',r.bug_id,'toState','fixing','actors',jsonb_build_array('deterministic_worker'),
      'guard',jsonb_build_object('fixLease',true,'artifactImmutable',true),
      'evidence',jsonb_build_object('failingArtifactDigest',reproduction_digest),
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
INSERT INTO otl.schema_migrations(version) VALUES('052-bug-runner-fix-lease-name');
COMMIT;
