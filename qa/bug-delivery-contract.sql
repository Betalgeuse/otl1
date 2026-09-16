\set QUIET 1
BEGIN;
CREATE TEMP TABLE delivery_result(key text PRIMARY KEY,value jsonb NOT NULL);

DO $$
DECLARE draft jsonb; transition jsonb; replay jsonb; delivery jsonb; crash_delivery jsonb; claimed jsonb; finished jsonb; looked_up jsonb; early jsonb; side_effect_failures integer:=0; attempt_number integer;
BEGIN
 SELECT otl.bug_create_draft(jsonb_build_object(
  'bugId','BUG-DELIVERY01','teamId','T-DELIVERY','publicAlias','B-DELIVERY0001','reporterId','U-OWNER','source','slack','sourceOpaqueRef','slack:T-DELIVERY:C-DELIVERY:1.1','sourceChannelId','C-DELIVERY','sourceThread','1.1','idempotencyKey','delivery-draft',
  'sanitizedFields',jsonb_build_object('title','delivery fixture','actual','fails','expected',null,'steps',jsonb_build_array('open','click'),'location','channel','occurredAt','2026-09-16T10:00:00Z','frequency','once','impact','blocked'),
  'opaqueRef','object/delivery/draft','objectDigest',repeat('1',64),'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456')) INTO draft;
 SELECT otl.bug_transition(jsonb_build_object(
  'bugId','BUG-DELIVERY01','toState','needs_info','actors',jsonb_build_array('deterministic_worker'),'guard',jsonb_build_object('missingRequiredField',true),
  'evidence',jsonb_build_object('reasonCodes','expected_missing','questionId','delivery-q1','fieldName','expected','templateVersion','question.expected.v1','questionText','renderer-only fixture'),
  'expectedRevision',0,'idempotencyKey','delivery-question')) INTO transition;
 SELECT otl.bug_transition(jsonb_build_object(
  'bugId','BUG-DELIVERY01','toState','needs_info','actors',jsonb_build_array('deterministic_worker'),'guard',jsonb_build_object('missingRequiredField',true),
  'evidence',jsonb_build_object('reasonCodes','expected_missing','questionId','delivery-q1','fieldName','expected','templateVersion','question.expected.v1','questionText','renderer-only fixture'),
  'expectedRevision',0,'idempotencyKey','delivery-question')) INTO replay;
 IF replay->>'idempotent'<>'true' OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-DELIVERY01')<>1 THEN RAISE EXCEPTION 'transition replay did not reproduce persisted-state condition'; END IF;

 SELECT otl.bug_enqueue_delivery(jsonb_build_object(
  'teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','deliveryKind','question','packetRevision',1,'questionId','delivery-q1','destination','reporter_thread',
  'templateId','question.expected.v1','fieldName','expected','rendererVersion','bug-question.v1','notBefore','2026-09-16T12:00:00Z')) INTO delivery;
 SELECT otl.bug_enqueue_delivery(jsonb_build_object(
  'teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','deliveryKind','question','packetRevision',1,'questionId','delivery-q1','destination','reporter_thread',
  'templateId','question.expected.v1','fieldName','expected','rendererVersion','bug-question.v1','notBefore','2026-09-16T12:00:00Z')) INTO replay;
 IF replay->>'delivery_id'<>delivery->>'delivery_id' OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-DELIVERY01' AND question_id='delivery-q1')<>1 THEN side_effect_failures:=side_effect_failures+1; END IF;
 BEGIN
  PERFORM otl.bug_get_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-WRONG','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread'));
  RAISE EXCEPTION 'wrong owner read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-WRONG','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','deliveryKind','question','packetRevision',1,'questionId','delivery-q1','destination','reporter_thread','templateId','question.expected.v1','fieldName','expected','rendererVersion','bug-question.v1'));
  RAISE EXCEPTION 'wrong team enqueue accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;

 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','workerId','slack-worker-1','leaseToken','lease-1','leaseSeconds',300,'now','2026-09-16T12:00:00Z')) INTO claimed;
 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','workerId','slack-worker-1','leaseToken','lease-1','leaseSeconds',300,'now','2026-09-16T12:00:01Z')) INTO replay;
 IF replay->>'delivery_id'<>claimed->>'delivery_id' OR replay->>'attempts'<>'1' THEN RAISE EXCEPTION 'claim replay was not idempotent'; END IF;
 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','workerId','competing-worker','leaseToken','competing-lease','leaseSeconds',300,'now','2026-09-16T12:00:02Z')) INTO early;
 IF early<>'null'::jsonb THEN RAISE EXCEPTION 'competing claim bypassed lease CAS'; END IF;
 BEGIN
  PERFORM otl.bug_finish_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryId',(delivery->>'delivery_id')::bigint,'workerId','other-worker','leaseToken','wrong-token','status','sent','messageTs','1.2','now','2026-09-16T12:01:00Z'));
  RAISE EXCEPTION 'wrong lease finish accepted';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 SELECT otl.bug_finish_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryId',(delivery->>'delivery_id')::bigint,'workerId','slack-worker-1','leaseToken','lease-1','status','failed','errorCode','slack_api_error','retryAfter','2026-09-16T12:05:00Z','now','2026-09-16T12:01:00Z')) INTO finished;
 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','workerId','slack-worker-2','leaseToken','lease-early','leaseSeconds',300,'now','2026-09-16T12:04:59Z')) INTO early;
 IF early<>'null'::jsonb THEN RAISE EXCEPTION 'retry claimed before retry_after'; END IF;
 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread','workerId','slack-worker-2','leaseToken','lease-2','leaseSeconds',300,'now','2026-09-16T12:05:00Z')) INTO claimed;
 IF claimed->>'delivery_id'<>delivery->>'delivery_id' OR claimed->>'attempts'<>'2' THEN RAISE EXCEPTION 'failed Slack delivery was not independently reclaimable'; END IF;
 SELECT otl.bug_finish_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryId',(delivery->>'delivery_id')::bigint,'workerId','slack-worker-2','leaseToken','lease-2','status','sent','messageTs','1700000000.000002','now','2026-09-16T12:06:00Z')) INTO finished;
 SELECT otl.bug_get_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:1:question:reporter_thread')) INTO looked_up;
 IF looked_up->>'status'<>'sent' OR looked_up->>'attempts'<>'2' OR looked_up->>'message_ts'<>'1700000000.000002' THEN RAISE EXCEPTION 'sent delivery receipt mismatch'; END IF;

 PERFORM otl.bug_answer_revision(jsonb_build_object(
  'bugId','BUG-DELIVERY01','reporterId','U-OWNER','questionId','delivery-q1','answerDigest',repeat('a',64),'answerOpaqueRef','object/delivery/answer','expectedPacketRevision',1,'idempotencyKey','delivery-answer',
  'sanitizedFields',jsonb_build_object('actual','fails','expected','partially clarified','steps',jsonb_build_array('open','click'),'location','channel','occurredAt','2026-09-16T10:00:00Z','frequency','once','impact','blocked'),
  'completeness',jsonb_build_object('status','needs_info'),'opaqueRef','object/delivery/revision2','objectDigest',repeat('b',64),'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321'));

 SELECT otl.bug_transition(jsonb_build_object(
  'bugId','BUG-DELIVERY01','toState','needs_info','actors',jsonb_build_array('reporter','deterministic_worker'),'guard',jsonb_build_object('stillIncomplete',true),
  'evidence',jsonb_build_object('answerRevision','2','completenessResult','missing actual','questionId','delivery-q2','fieldName','actual','templateVersion','question.actual.v1','questionText','renderer-only fixture'),
  'expectedRevision',1,'idempotencyKey','delivery-question-2')) INTO transition;
 SELECT otl.bug_enqueue_delivery(jsonb_build_object(
  'teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_thread','deliveryKind','question','packetRevision',2,'questionId','delivery-q2','destination','reporter_thread',
  'templateId','question.actual.v1','fieldName','actual','rendererVersion','bug-question.v1','notBefore','2026-09-16T13:00:00Z')) INTO delivery;
 FOR attempt_number IN 1..3 LOOP
  SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_thread','workerId','dead-worker-'||attempt_number,'leaseToken','dead-lease-'||attempt_number,'leaseSeconds',300,'now',format('2026-09-16T13:%s:00Z',lpad(((attempt_number-1)*10)::text,2,'0')))) INTO claimed;
  SELECT otl.bug_finish_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryId',(delivery->>'delivery_id')::bigint,'workerId','dead-worker-'||attempt_number,'leaseToken','dead-lease-'||attempt_number,'status','failed','errorCode','slack_api_error','retryAfter',format('2026-09-16T13:%s:00Z',lpad((attempt_number*10)::text,2,'0')),'now',format('2026-09-16T13:%s:30Z',lpad(((attempt_number-1)*10)::text,2,'0')))) INTO finished;
 END LOOP;
 SELECT otl.bug_get_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_thread')) INTO looked_up;
 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_thread','workerId','dead-worker-4','leaseToken','dead-lease-4','leaseSeconds',300,'now','2026-09-16T14:00:00Z')) INTO claimed;
 IF claimed<>'null'::jsonb OR looked_up->>'status'<>'failed' OR looked_up->>'attempts'<>'3' OR looked_up->>'retry_after' IS NOT NULL THEN RAISE EXCEPTION 'third failure was not dead-lettered'; END IF;

 SELECT otl.bug_enqueue_delivery(jsonb_build_object(
  'teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_ephemeral','deliveryKind','question','packetRevision',2,'questionId','delivery-q2','destination','reporter_ephemeral',
  'templateId','question.actual.v1','fieldName','actual','rendererVersion','bug-question.v1','notBefore','2026-09-16T14:00:00Z')) INTO crash_delivery;
 FOR attempt_number IN 1..2 LOOP
  SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_ephemeral','workerId','crash-worker','leaseToken','crash-lease-'||attempt_number,'leaseSeconds',30,'now',format('2026-09-16T14:0%s:00Z',attempt_number-1))) INTO claimed;
  SELECT otl.bug_finish_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryId',(crash_delivery->>'delivery_id')::bigint,'workerId','crash-worker','leaseToken','crash-lease-'||attempt_number,'status','failed','errorCode','provider_error','retryAfter',format('2026-09-16T14:0%s:00Z',attempt_number),'now',format('2026-09-16T14:0%s:20Z',attempt_number-1))) INTO finished;
 END LOOP;
 SELECT otl.bug_claim_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:question:reporter_ephemeral','workerId','crash-worker','leaseToken','crash-lease-3','leaseSeconds',30,'now','2026-09-16T14:02:00Z')) INTO claimed;
 IF claimed->>'status'<>'claimed' OR claimed->>'attempts'<>'3' THEN RAISE EXCEPTION 'third crash claim setup failed'; END IF;

 INSERT INTO delivery_result VALUES
  ('independent_retry',to_jsonb(true)),('sent_status',to_jsonb((SELECT status FROM otl.bug_deliveries WHERE question_id='delivery-q1'))),
  ('sent_attempts',to_jsonb((SELECT attempts FROM otl.bug_deliveries WHERE question_id='delivery-q1'))),
  ('dead_status',to_jsonb((SELECT status FROM otl.bug_deliveries WHERE question_id='delivery-q2' AND destination='reporter_thread'))),
  ('dead_attempts',to_jsonb((SELECT attempts FROM otl.bug_deliveries WHERE question_id='delivery-q2' AND destination='reporter_thread'))),
  ('question_events',to_jsonb((SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-DELIVERY01'))),
  ('side_effect_failures',to_jsonb(side_effect_failures));
END $$;

DO $$
DECLARE delivery jsonb;
BEGIN
 PERFORM otl.bug_create_draft(jsonb_build_object(
  'bugId','BUG-SUMMARY01','teamId','T-DELIVERY','publicAlias','B-SUMMARY001','reporterId','U-OWNER','source','slack','sourceOpaqueRef','slack:T-DELIVERY:C-DELIVERY:2.1','idempotencyKey','summary-draft',
  'sanitizedFields',jsonb_build_object('title','summary fixture','actual','fails','expected','works','steps',jsonb_build_array('open','click'),'location','channel','occurredAt','2026-09-16T10:00:00Z','frequency','once','impact','blocked'),
  'opaqueRef','object/summary/draft','objectDigest',repeat('2',64),'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'));
 SELECT otl.bug_enqueue_delivery(jsonb_build_object(
  'teamId','T-DELIVERY','bugId','BUG-SUMMARY01','reporterId','U-OWNER','deliveryKey','BUG-SUMMARY01:1:summary:reporter_thread','deliveryKind','summary','packetRevision',1,'destination','reporter_thread','templateId','summary.confirmation.v1','rendererVersion','bug-summary.v1')) INTO delivery;
 IF delivery->>'delivery_kind'<>'summary' OR delivery->>'question_id' IS NOT NULL OR delivery->>'field_name' IS NOT NULL THEN RAISE EXCEPTION 'summary delivery shape mismatch'; END IF;
 BEGIN
  PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-SUMMARY01','reporterId','U-OWNER','deliveryKey','BUG-SUMMARY01:1:summary:reporter_ephemeral','deliveryKind','summary','packetRevision',1,'questionId','forbidden','destination','reporter_ephemeral','templateId','summary.confirmation.v1','rendererVersion','bug-summary.v1'));
  RAISE EXCEPTION 'non-question accepted question metadata';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-SUMMARY01','reporterId','U-OWNER','deliveryKey','BUG-SUMMARY01:1:summary:reporter_ephemeral','deliveryKind','summary','packetRevision',1,'destination','reporter_ephemeral','templateId','receipt.confirmed.v1','rendererVersion','bug-summary.v1'));
  RAISE EXCEPTION 'wrong template kind accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-SUMMARY01','reporterId','U-OWNER','deliveryKey','BUG-SUMMARY01:2:summary:reporter_ephemeral','deliveryKind','summary','packetRevision',2,'destination','reporter_ephemeral','templateId','summary.confirmation.v1','rendererVersion','bug-summary.v1'));
  RAISE EXCEPTION 'stale delivery revision accepted';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 BEGIN
  PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-SUMMARY01','reporterId','U-OWNER','deliveryKey','BUG-SUMMARY01:1:admin_handoff:admin_channel','deliveryKind','admin_handoff','packetRevision',1,'destination','admin_channel','templateId','admin_handoff.private.v1','rendererVersion','bug-handoff.v1'));
  RAISE EXCEPTION 'admin handoff accepted from new state';
 EXCEPTION WHEN check_violation THEN NULL; END;
 PERFORM otl.bug_transition(jsonb_build_object('bugId','BUG-SUMMARY01','toState','private_incident','actors',jsonb_build_array('admin'),'guard',jsonb_build_object('privacyOrSecurity',true),'evidence',jsonb_build_object('intakeDigest',repeat('2',64)),'expectedRevision',0,'idempotencyKey','summary-private'));
 PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-SUMMARY01','reporterId','U-OWNER','deliveryKey','BUG-SUMMARY01:1:admin_handoff:admin_channel','deliveryKind','admin_handoff','packetRevision',1,'destination','admin_channel','templateId','admin_handoff.private.v1','rendererVersion','bug-handoff.v1'));

 PERFORM otl.bug_create_draft(jsonb_build_object(
  'bugId','BUG-RECEIPT01','teamId','T-DELIVERY','publicAlias','B-RECEIPT001','reporterId','U-OWNER','source','api','sourceOpaqueRef','receipt-source','idempotencyKey','receipt-draft',
  'sanitizedFields',jsonb_build_object('title','receipt fixture','actual','fails','expected','works','steps',jsonb_build_array('open','click'),'location','channel','occurredAt','2026-09-16T10:00:00Z','frequency','once','impact','blocked'),
  'opaqueRef','object/receipt/draft','objectDigest',repeat('3',64),'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'));
 PERFORM otl.bug_confirm_packet(jsonb_build_object(
  'packet',jsonb_build_object('schemaVersion','bug_packet.v1','bugId','BUG-RECEIPT01','status','confirmed','revision',1,'fields',jsonb_build_object('actual','fails','expected','works','steps',jsonb_build_array('open','click'),'location','channel','occurredAt','2026-09-16T10:00:00+09:00','frequency','once','impact','blocked'),'confirmation',jsonb_build_object('reporterConfirmed',true,'confirmedAt','2026-09-16T10:01:00+09:00'),'source',jsonb_build_object('kind','api','opaqueRef','receipt-source'),'evidenceDigest',repeat('4',64),'packetDigest',repeat('5',64)),
  'storage',jsonb_build_object('teamId','T-DELIVERY','reporterId','U-OWNER','expectedPacketRevision',1,'idempotencyKey','receipt-confirm','opaqueRef','object/receipt/confirmed','objectDigest',repeat('6',64),'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321')));
 PERFORM otl.bug_transition(jsonb_build_object('bugId','BUG-RECEIPT01','toState','triaged','actors',jsonb_build_array('deterministic_worker'),'guard',jsonb_build_object('formComplete',true,'privacyFalse',true),'evidence',jsonb_build_object('packetDigest',repeat('5',64)),'expectedRevision',0,'idempotencyKey','receipt-triage'));
 PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-RECEIPT01','reporterId','U-OWNER','deliveryKey','BUG-RECEIPT01:2:receipt:reporter_ephemeral','deliveryKind','receipt','packetRevision',2,'destination','reporter_ephemeral','templateId','receipt.confirmed.v1','rendererVersion','bug-receipt.v1'));

 PERFORM otl.bug_create_draft(jsonb_build_object(
  'bugId','BUG-CANCELLED1','teamId','T-DELIVERY','publicAlias','B-CANCELLED01','reporterId','U-OWNER','source','slack','sourceOpaqueRef','cancel-source','idempotencyKey','cancel-draft',
  'sanitizedFields',jsonb_build_object('title','cancel fixture','actual','stopped','steps','[]'::jsonb),'opaqueRef','object/cancel/draft','objectDigest',repeat('7',64),'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'));
 PERFORM otl.bug_transition(jsonb_build_object('bugId','BUG-CANCELLED1','toState','rejected','actors',jsonb_build_array('admin'),'guard',jsonb_build_object('rejectable',true),'evidence',jsonb_build_object('reasonCode','withdrawn'),'expectedRevision',0,'idempotencyKey','cancel-reject'));
 PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-CANCELLED1','reporterId','U-OWNER','deliveryKey','BUG-CANCELLED1:1:receipt:reporter_ephemeral','deliveryKind','receipt','packetRevision',1,'destination','reporter_ephemeral','templateId','receipt.cancelled.v1','rendererVersion','bug-receipt.v1'));

 UPDATE otl.bug_reports SET question_count=5,needs_info_started_at='2026-09-15T00:00:00Z' WHERE bug_id='BUG-DELIVERY01';
 PERFORM otl.bug_transition(jsonb_build_object('bugId','BUG-DELIVERY01','toState','needs_info_exhausted','actors',jsonb_build_array('scheduler'),'guard',jsonb_build_object('exhausted',true),'evidence',jsonb_build_object('conversationDigest',repeat('8',64),'exhaustionReason','five'),'expectedRevision',2,'idempotencyKey','delivery-exhausted','now','2026-09-16T15:00:00Z'));
 PERFORM otl.bug_enqueue_delivery(jsonb_build_object('teamId','T-DELIVERY','bugId','BUG-DELIVERY01','reporterId','U-OWNER','deliveryKey','BUG-DELIVERY01:2:admin_handoff:admin_channel','deliveryKind','admin_handoff','packetRevision',2,'destination','admin_channel','templateId','admin_handoff.exhausted.v1','rendererVersion','bug-handoff.v1'));

 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='otl' AND table_name='bug_deliveries' AND column_name IN ('payload','body','text','question_text','error_message')) THEN RAISE EXCEPTION 'raw delivery payload column exists'; END IF;
 INSERT INTO delivery_result VALUES('delivery_kinds',to_jsonb((SELECT count(DISTINCT delivery_kind) FROM otl.bug_deliveries)));
END $$;

DO $$
DECLARE cleanup_rows bigint;
BEGIN
 BEGIN
  INSERT INTO otl.bug_deliveries(delivery_key,delivery_kind,team_id,bug_id,packet_revision,question_id,destination,template_id,field_name,renderer_version)
  SELECT bug_id||':1:question:admin_channel','question','T-DELIVERY',bug_id,1,'delivery-q1','admin_channel','question.expected.v1','expected','bug-question.v1' FROM otl.bug_reports WHERE bug_id='BUG-DELIVERY01';
  RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='rollback delivery fixture';
 EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 SELECT count(*) INTO cleanup_rows FROM otl.bug_deliveries WHERE delivery_key='BUG-DELIVERY01:1:question:admin_channel';
 INSERT INTO delivery_result VALUES('cleanup_rows',to_jsonb(cleanup_rows));
END $$;

DO $$
DECLARE claimed jsonb; route jsonb; jobs_before bigint; jobs_after bigint;
BEGIN
 SELECT count(*) INTO jobs_before FROM otl.bug_jobs;
 SELECT otl.bug_claim_due_deliveries(jsonb_build_object(
  'teamId','T-DELIVERY','workerId','slack-bug-delivery','leaseToken','scheduled-lease','leaseSeconds',300,
  'limit',2,'now','2026-09-17T12:00:00Z')) INTO claimed;
 SELECT count(*) INTO jobs_after FROM otl.bug_jobs;
 IF EXISTS(SELECT 1 FROM otl.bug_deliveries WHERE delivery_key='BUG-DELIVERY01:2:question:reporter_ephemeral' AND (status<>'failed' OR attempts<>3 OR last_error_code<>'timeout' OR worker_id IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
 THEN RAISE EXCEPTION 'expired third claim was not terminalized'; END IF;
 IF jsonb_array_length(claimed)<>2
    OR NOT claimed @> jsonb_build_array(jsonb_build_object('delivery_kind','admin_handoff','status','claimed','attempts',1,'source_channel_id','C-DELIVERY','source_thread','1.1'))
    OR NOT claimed @> jsonb_build_array(jsonb_build_object('delivery_kind','question','status','claimed','attempts',1,'source_channel_id','C-DELIVERY','source_thread','3.1'))
    OR jobs_before<>jobs_after
 THEN RAISE EXCEPTION 'autonomous due delivery claim contract failed: %',claimed; END IF;
 FOR route IN SELECT value FROM jsonb_array_elements(claimed) LOOP
  PERFORM otl.bug_finish_delivery(jsonb_build_object(
   'teamId',route->>'team_id','bugId',route->>'bug_id','reporterId',route->>'reporter_id',
   'deliveryId',(route->>'delivery_id')::bigint,'workerId','slack-bug-delivery',
   'leaseToken','scheduled-lease','status','failed',
   'errorCode',CASE WHEN route->>'delivery_kind'='question' THEN 'invalid_payload' ELSE 'provider_error' END,
   'retryAfter','2026-09-17T12:02:00Z','now','2026-09-17T12:00:30Z'));
 END LOOP;
 INSERT INTO delivery_result VALUES('autonomous_due',to_jsonb(jsonb_array_length(claimed)));
 INSERT INTO delivery_result VALUES('expired_third_claim',to_jsonb(true));
END $$;

SELECT jsonb_build_object(
 'autonomousDue',(SELECT value FROM delivery_result WHERE key='autonomous_due'),
 'expiredThirdClaim',(SELECT value FROM delivery_result WHERE key='expired_third_claim'),
 'independentRetry',(SELECT value FROM delivery_result WHERE key='independent_retry'),
 'deliveryKinds',(SELECT value FROM delivery_result WHERE key='delivery_kinds'),
 'sentStatus',(SELECT value #>> '{}' FROM delivery_result WHERE key='sent_status'),
 'sentAttempts',(SELECT value FROM delivery_result WHERE key='sent_attempts'),
 'deadLetterStatus',(SELECT value #>> '{}' FROM delivery_result WHERE key='dead_status'),
 'deadLetterAttempts',(SELECT value FROM delivery_result WHERE key='dead_attempts'),
 'questionEvents',(SELECT value FROM delivery_result WHERE key='question_events'),
 'sideEffectFailures',(SELECT value FROM delivery_result WHERE key='side_effect_failures'),
 'cleanupRows',(SELECT value FROM delivery_result WHERE key='cleanup_rows')
);
ROLLBACK;
