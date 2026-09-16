\set QUIET 1
BEGIN;
SELECT otl.bug_create_draft(jsonb_build_object(
  'bugId','BUG-BACKFILL021A','teamId','T-BACKFILL-A','publicAlias','B-BACKFILL021A0',
  'reporterId','U-BACKFILL','source','slack','sourceOpaqueRef','slack:T-BACKFILL-A:C:1',
  'sourceChannelId','C-BACKFILL','sourceThread','1.1','idempotencyKey','backfill-021-draft',
  'sanitizedFields',jsonb_build_object(
    'title','CANARY-BACKFILL-021','actual','CANARY-BACKFILL-021',
    'expected','CANARY-BACKFILL-021','steps',jsonb_build_array('CANARY-BACKFILL-021'),
    'location','CANARY-BACKFILL-021','occurredAt','2026-09-17T10:00:00Z',
    'frequency','once','impact','security_privacy','privacy',false
  ),
  'opaqueRef','bugs/backfill021/revision-1.enc','objectDigest',repeat('a',64),
  'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'
));
SELECT otl.bug_transition(jsonb_build_object(
  'bugId','BUG-BACKFILL021A','toState','needs_info','actors',jsonb_build_array('deterministic_worker'),
  'guard',jsonb_build_object('missingRequiredField',true),
  'evidence',jsonb_build_object(
    'reasonCodes','missing','questionId','backfill-q1','fieldName','actual',
    'templateVersion','CANARY-BACKFILL-021','questionText','CANARY-BACKFILL-021'
  ),
  'expectedRevision',0,'idempotencyKey','backfill-question'
));
SELECT otl.bug_enqueue_delivery(jsonb_build_object(
  'teamId','T-BACKFILL-A','bugId','BUG-BACKFILL021A','reporterId','U-BACKFILL',
  'deliveryKey','BUG-BACKFILL021A:1:question:reporter_thread','deliveryKind','question',
  'packetRevision',1,'questionId','backfill-q1','destination','reporter_thread',
  'templateId','CANARY-BACKFILL-021','fieldName','actual','rendererVersion','CANARY-BACKFILL-021'
));
SELECT otl.bug_answer_revision(jsonb_build_object(
  'bugId','BUG-BACKFILL021A','reporterId','U-BACKFILL','questionId','backfill-q1',
  'answerDigest',repeat('b',64),'answerOpaqueRef','bugs/backfill021/answer-raw.enc',
  'expectedPacketRevision',1,'idempotencyKey','backfill-answer',
  'sanitizedFields',jsonb_build_object(
    'actual','CANARY-BACKFILL-021','expected','CANARY-BACKFILL-021',
    'steps',jsonb_build_array('CANARY-BACKFILL-021','CANARY-BACKFILL-021'),
    'location','CANARY-BACKFILL-021','occurredAt','2026-09-17T10:01:00Z',
    'frequency','once','impact','security_privacy'
  ),
  'completeness',jsonb_build_object('secret','CANARY-BACKFILL-021'),
  'opaqueRef','bugs/backfill021/revision-2.enc','objectDigest',repeat('b',64),
  'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321'
));
SELECT otl.bug_confirm_packet(jsonb_build_object(
  'packet',jsonb_build_object(
    'schemaVersion','bug_packet.v1','bugId','BUG-BACKFILL021A','status','confirmed','revision',3,
    'fields',jsonb_build_object(
      'actual','CANARY-BACKFILL-021','expected','CANARY-BACKFILL-021',
      'steps',jsonb_build_array('CANARY-BACKFILL-021','CANARY-BACKFILL-021'),
      'location','CANARY-BACKFILL-021','occurredAt','2026-09-17T10:01:00+09:00',
      'frequency','once','impact','security_privacy'
    ),
    'confirmation',jsonb_build_object('reporterConfirmed',true,'confirmedAt','2026-09-17T10:02:00+09:00'),
    'source',jsonb_build_object('kind','slack','opaqueRef','slack:T-BACKFILL-A:C:1'),
    'evidenceDigest',repeat('c',64),'packetDigest',repeat('d',64)
  ),
  'storage',jsonb_build_object(
    'teamId','T-BACKFILL-A','reporterId','U-BACKFILL','expectedPacketRevision',2,
    'idempotencyKey','backfill-confirm','opaqueRef','bugs/backfill021/revision-3.enc',
    'objectDigest',repeat('c',64),'envelopeDek','encrypted-envelope','kekVersion','v1',
    'nonce','nonce-confirmed'
  )
));
SELECT otl.bug_transition(jsonb_build_object(
  'bugId','BUG-BACKFILL021A','toState','private_incident','actors',jsonb_build_array('admin'),
  'guard',jsonb_build_object('privacyOrSecurity',true),
  'evidence',jsonb_build_object('intakeDigest',repeat('a',64)),
  'expectedRevision',1,'idempotencyKey','backfill-private'
));
COMMIT;

DO $$
BEGIN
  IF (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-BACKFILL021A')<>'private_incident'
     OR NOT EXISTS(SELECT 1 FROM otl.bug_reports WHERE bug_id='BUG-BACKFILL021A'
       AND to_jsonb(bug_reports)::text LIKE '%CANARY-BACKFILL-021%')
     OR (SELECT packet_revision FROM otl.bug_reports WHERE bug_id='BUG-BACKFILL021A')<>3
     OR (SELECT count(*) FROM otl.bug_report_revisions WHERE bug_id='BUG-BACKFILL021A')<>3
     OR NOT EXISTS(SELECT 1 FROM otl.bug_report_revisions WHERE bug_id='BUG-BACKFILL021A'
       AND packet_revision=3 AND confirmed_packet::text LIKE '%CANARY-BACKFILL-021%')
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-BACKFILL021A')<>2
  THEN RAISE EXCEPTION 'pre-021 private canary fixture was not created'; END IF;
END $$;
