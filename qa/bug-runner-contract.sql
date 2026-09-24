BEGIN;
SET LOCAL search_path = pg_catalog, otl;

INSERT INTO otl.bug_reports(
  bug_id,team_id,state,revision,packet_revision,public_alias,reporter_id,source,
  source_opaque_ref,source_channel_id,source_thread,title,actual,expected,steps,location,
  occurred_at,frequency,impact,confirmed_packet_digest,confirmed_evidence_digest
) VALUES(
  'BUG-RUNNER000001','T-RUNNER','triaged',1,1,'B-RUNNER000001','U-REPORTER','slack',
  'slack:T-RUNNER:C-RUNNER:1.1','C-RUNNER','1.1','runner contract','observed','expected',
  '["open","submit"]','feedback','2026-09-24T10:00:00Z','always','blocked',repeat('a',64),repeat('b',64)
);
INSERT INTO otl.bug_report_revisions(
  bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,
  envelope_dek,kek_version,nonce,evidence_digest,packet_digest,confirmed_packet,
  reporter_confirmed,confirmed_at,evidence_object_digest
) VALUES(
  'BUG-RUNNER000001',1,'bug_packet.v1','confirmed','{"actual":"observed"}',
  'object/runner/confirmed',repeat('c',64),repeat('e',32),'v1','nonce-runner-1234',
  repeat('b',64),repeat('a',64),
  '{"schemaVersion":"bug_packet.v1","status":"confirmed","fields":{"actual":"observed","expected":"expected","steps":["open","submit"],"location":"feedback","occurredAt":"2026-09-24T19:00:00+09:00","frequency":"always","impact":"blocked"}}',
  true,'2026-09-24T10:00:00Z',repeat('c',64)
);

DO $$
DECLARE queued jsonb; replay jsonb; leased jsonb; started jsonb; finished jsonb; claimed jsonb;
BEGIN
  queued:=otl.bug_admin_queue(jsonb_build_object(
    'teamId','T-RUNNER','bugId','BUG-RUNNER000001','reporterId','U-REPORTER','adminId','U-ADMIN',
    'packetRevision',1,'baseSha',repeat('d',40),'approvalReceipt',repeat('e',64),'idempotencyKey','admin-queue-1'
  ));
  IF queued->>'accepted'<>'true' OR queued->>'state'<>'queued' THEN RAISE EXCEPTION 'admin queue failed'; END IF;
  replay:=otl.bug_admin_queue(jsonb_build_object(
    'teamId','T-RUNNER','bugId','BUG-RUNNER000001','reporterId','U-REPORTER','adminId','U-ADMIN',
    'packetRevision',1,'baseSha',repeat('d',40),'approvalReceipt',repeat('e',64),'idempotencyKey','admin-queue-1'
  ));
  IF replay->>'idempotent'<>'true' OR (SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-RUNNER000001' AND kind='reproduce')<>1
  THEN RAISE EXCEPTION 'admin queue replay duplicated'; END IF;
  IF otl.bug_runner_lease(jsonb_build_object(
    'teamId','T-OTHER','workerId','runner-1','accountAlias','account-a','leaseToken','wrong-team',
    'runnerImageDigest',repeat('f',64)
  )) <> 'null'::jsonb THEN RAISE EXCEPTION 'cross-team runner lease accepted'; END IF;
  leased:=otl.bug_runner_lease(jsonb_build_object(
    'teamId','T-RUNNER','workerId','runner-1','accountAlias','account-a','leaseToken','lease-1',
    'runnerImageDigest',repeat('f',64)
  ));
  IF leased->'job'->>'status'<>'leased' OR leased->'bug'->>'state'<>'reproducing'
     OR leased->'bug'->>'baseSha'<>repeat('d',40) OR leased->'bug'->'confirmedPacket' IS NULL
  THEN RAISE EXCEPTION 'runner lease contract failed'; END IF;
  started:=otl.bug_runner_start(jsonb_build_object(
    'teamId','T-RUNNER','jobId',(leased->'job'->>'job_id')::bigint,'workerId','runner-1','leaseToken','lease-1',
    'runId','run-contract-1','baseSha',repeat('d',40),'promptDigest',repeat('1',64),
    'providerTaskId','task_e_0123456789abcdef0123456789abcdef',
    'providerTaskUrl','https://chatgpt.com/codex/tasks/task_e_0123456789abcdef0123456789abcdef'
  ));
  IF started->>'runId'<>'run-contract-1' OR (SELECT count(*) FROM otl.bug_runner_notifications WHERE kind='task_started')<>1
  THEN RAISE EXCEPTION 'runner start receipt failed'; END IF;
  finished:=otl.bug_runner_finish(jsonb_build_object(
    'teamId','T-RUNNER','jobId',(leased->'job'->>'job_id')::bigint,'workerId','runner-1','leaseToken','lease-1',
    'runId','run-contract-1','status','succeeded','exitClass','reproduced','elapsedMs',1000,
    'artifactDigest',repeat('2',64),'resultDigest',repeat('3',64)
  ));
  IF finished->'job'->>'status'<>'succeeded' OR (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-RUNNER000001')<>'reproduced'
     OR (SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-RUNNER000001' AND kind='fix')<>1
     OR (SELECT count(*) FROM otl.bug_runner_notifications WHERE kind='task_ready')<>1
  THEN RAISE EXCEPTION 'runner finish transition failed'; END IF;
  claimed:=otl.bug_runner_claim_notifications(jsonb_build_object('teamId','T-RUNNER','leaseToken','delivery-lease','limit',10));
  IF jsonb_array_length(claimed)<>2 THEN RAISE EXCEPTION 'runner notifications not claimable'; END IF;
  PERFORM otl.bug_runner_finish_notification(jsonb_build_object(
    'notificationId',(claimed->0->>'notification_id')::bigint,'leaseToken','delivery-lease','status','sent'
  ));
  IF (SELECT count(*) FROM otl.bug_runner_notifications WHERE status='sent')<>1 THEN RAISE EXCEPTION 'notification finish failed'; END IF;
END $$;

DO $$ BEGIN
  IF NOT has_function_privilege('otl_bug_runner','otl.bug_runner_lease(jsonb)','EXECUTE')
     OR NOT has_function_privilege('otl_bug_runner','otl.bug_runner_start(jsonb)','EXECUTE')
     OR has_table_privilege('otl_bug_runner','otl.bug_reports','SELECT')
     OR has_table_privilege('otl_bug_runner','otl.agent_runs','SELECT')
  THEN RAISE EXCEPTION 'runner least privilege contract failed'; END IF;
END $$;

SELECT jsonb_build_object(
  'state',(SELECT state FROM otl.bug_reports WHERE bug_id='BUG-RUNNER000001'),
  'reproduceJobs',(SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-RUNNER000001' AND kind='reproduce'),
  'fixJobs',(SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-RUNNER000001' AND kind='fix'),
  'runs',(SELECT count(*) FROM otl.agent_runs WHERE bug_id='BUG-RUNNER000001'),
  'notifications',(SELECT count(*) FROM otl.bug_runner_notifications WHERE bug_id='BUG-RUNNER000001')
);
ROLLBACK;
