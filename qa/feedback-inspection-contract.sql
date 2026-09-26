BEGIN;
SET LOCAL search_path=pg_catalog,otl;
INSERT INTO otl.bug_reports(
 bug_id,team_id,state,revision,packet_revision,public_alias,reporter_id,source,
 source_opaque_ref,source_channel_id,source_thread,title,actual,expected,
 confirmed_packet_digest,confirmed_evidence_digest
) VALUES(
 'BUG-FBINSPECT0001','T-FBINSPECT','triaged',1,1,'B-ABCDEF1234567890','U-REPORTER','slack',
 'slack-feedback:T-FBINSPECT:U-REPORTER:qa','C-FEEDBACK','1.1','feedback inspection',
 'live symptom','desired behavior',repeat('a',64),repeat('b',64)
);
INSERT INTO otl.bug_report_revisions(
 bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,
 envelope_dek,kek_version,nonce,evidence_digest,packet_digest,confirmed_packet,
 reporter_confirmed,confirmed_at,evidence_object_digest
) VALUES(
 'BUG-FBINSPECT0001',1,'feedback_packet.v1','confirmed',
 '{"actual":"live symptom","expected":"desired behavior"}',
 'object/feedback/confirmed',repeat('c',64),repeat('e',32),'v1','nonce-feedback12',
 repeat('b',64),repeat('a',64),
 '{"schemaVersion":"feedback_packet.v1","status":"confirmed","fields":{"actual":"live symptom","expected":"desired behavior"}}',
 true,clock_timestamp(),repeat('c',64)
);
INSERT INTO otl.bug_runner_repository_heads(team_id,repository,branch,head_sha,observed_at,worker_id)
VALUES('T-FBINSPECT','Betalgeuse/otl1','main',repeat('d',40),clock_timestamp(),'contract-runner');

DO $$
DECLARE queued jsonb; leased jsonb; started jsonb; finished jsonb;
BEGIN
 queued:=otl.bug_admin_queue(jsonb_build_object(
   'teamId','T-FBINSPECT','bugId','BUG-FBINSPECT0001','reporterId','U-REPORTER','adminId','U-ADMIN',
   'packetRevision',1,'repository','Betalgeuse/otl1','branch','main',
   'approvalReceipt',repeat('e',64),'idempotencyKey','fb-inspection-queue'
 ));
 IF queued->>'accepted'<>'true' THEN RAISE EXCEPTION 'feedback queue rejected: %',queued; END IF;
 leased:=otl.bug_runner_lease(jsonb_build_object(
   'teamId','T-FBINSPECT','workerId','contract-runner','accountAlias','account-a',
   'leaseToken','fb-inspection-lease','runnerImageDigest',repeat('f',64)
 ));
 started:=otl.bug_runner_start(jsonb_build_object(
   'teamId','T-FBINSPECT','jobId',(leased->'job'->>'job_id')::bigint,
   'workerId','contract-runner','leaseToken','fb-inspection-lease',
   'runId','run-feedback-inspection','baseSha',repeat('d',40),'promptDigest',repeat('1',64),
   'providerTaskId','task_e_1123456789abcdef0123456789abcdef',
   'providerTaskUrl','https://chatgpt.com/codex/tasks/task_e_1123456789abcdef0123456789abcdef'
 ));
 finished:=otl.bug_runner_finish(jsonb_build_object(
   'teamId','T-FBINSPECT','jobId',(leased->'job'->>'job_id')::bigint,
   'workerId','contract-runner','leaseToken','fb-inspection-lease',
   'runId','run-feedback-inspection','status','succeeded','exitClass','inspected',
   'failureObserved',false,'elapsedMs',1000,'artifactDigest',repeat('2',64),'resultDigest',repeat('3',64)
 ));
 IF (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-FBINSPECT0001')<>'reproduced'
    OR (SELECT exit_class FROM otl.agent_runs WHERE run_id='run-feedback-inspection')<>'inspected'
    OR (SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-FBINSPECT0001' AND kind='fix' AND status='queued')<>1
    OR NOT EXISTS(SELECT 1 FROM otl.bug_events WHERE bug_id='BUG-FBINSPECT0001' AND variant='feedback_inspected')
 THEN RAISE EXCEPTION 'feedback static inspection did not continue to fix'; END IF;
END $$;
SELECT jsonb_build_object(
 'state',(SELECT state FROM otl.bug_reports WHERE bug_id='BUG-FBINSPECT0001'),
 'exitClass',(SELECT exit_class FROM otl.agent_runs WHERE run_id='run-feedback-inspection'),
 'fixJobs',(SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-FBINSPECT0001' AND kind='fix'),
 'variant',(SELECT variant FROM otl.bug_events WHERE bug_id='BUG-FBINSPECT0001' AND to_state='reproduced')
);
ROLLBACK;
