\set QUIET 1
BEGIN;

DO $$
DECLARE created jsonb; canary text:='CANARY-PRIVATE-DRAFT-020'; relational text;
BEGIN
  SELECT otl.bug_create_draft_atomic(jsonb_build_object(
    'bugId','BUG-PRIVATE020D1','teamId','T-PRIVATE-020','publicAlias','B-PRIVATE020D10',
    'reporterId','U-PRIVATE','source','slack','sourceOpaqueRef','slack:T-PRIVATE-020:C:1',
    'sourceChannelId','C-PRIVATE','sourceThread','1.1','idempotencyKey','private-020-draft',
    'sanitizedFields',jsonb_build_object('title',canary,'actual',canary,'expected',canary,
      'steps',jsonb_build_array(canary,canary),'location',canary,'occurredAt','2026-09-17T10:00:00Z',
      'frequency','once','impact','security_privacy','privacy',true),
    'opaqueRef','bugs/private020/draft.enc','objectDigest',repeat('a',64),
    'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'
  )) INTO created;
  PERFORM otl.bug_create_draft_atomic(jsonb_build_object(
    'bugId','BUG-PRIVATE020D1','teamId','T-PRIVATE-020','publicAlias','B-PRIVATE020D10',
    'reporterId','U-PRIVATE','source','slack','sourceOpaqueRef','slack:T-PRIVATE-020:C:1',
    'sourceChannelId','C-PRIVATE','sourceThread','1.1','idempotencyKey','private-020-draft',
    'sanitizedFields',jsonb_build_object('title',canary,'actual',canary,'expected',canary,
      'steps',jsonb_build_array(canary,canary),'location',canary,'occurredAt','2026-09-17T10:00:00Z',
      'frequency','once','impact','security_privacy','privacy',true),
    'opaqueRef','bugs/private020/draft.enc','objectDigest',repeat('a',64),
    'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'
  ));
  SELECT concat_ws('|',to_jsonb(r)::text,string_agg(rev.sanitized_fields::text,'|')) INTO relational
  FROM otl.bug_reports r JOIN otl.bug_report_revisions rev USING(bug_id)
  WHERE r.bug_id='BUG-PRIVATE020D1' GROUP BY r.bug_id;
  IF created->>'state'<>'private_incident' OR created->>'revision'<>'1'
     OR relational LIKE '%'||canary||'%'
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-PRIVATE020D1'
       AND to_state='private_incident' AND guard_code='private')<>1
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-PRIVATE020D1'
       AND ((delivery_kind='receipt' AND destination='reporter_ephemeral')
         OR (delivery_kind='admin_handoff' AND destination='admin_channel'))
       AND status='pending')<>2
     OR EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id='BUG-PRIVATE020D1')
  THEN RAISE EXCEPTION 'private draft was not atomic, scrubbed, and job-free'; END IF;
END $$;

DO $$
DECLARE answered jsonb; canary text:='CANARY-PRIVATE-ANSWER-020'; relational text;
BEGIN
  PERFORM otl.bug_create_draft_atomic(jsonb_build_object(
    'bugId','BUG-PRIVATE020A1','teamId','T-PRIVATE-020','publicAlias','B-PRIVATE020A10',
    'reporterId','U-PRIVATE','source','slack','sourceOpaqueRef','slack:T-PRIVATE-020:C:2',
    'sourceChannelId','C-PRIVATE','sourceThread','2.1','idempotencyKey','private-020-answer-draft',
    'sanitizedFields',jsonb_build_object('title','normal','actual','observed','steps','[]'::jsonb,'privacy',false),
    'opaqueRef','bugs/private020/answer-draft.enc','objectDigest',repeat('b',64),
    'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'
  ));
  PERFORM otl.bug_transition(jsonb_build_object(
    'bugId','BUG-PRIVATE020A1','toState','needs_info','actors',jsonb_build_array('deterministic_worker'),
    'guard',jsonb_build_object('missingRequiredField',true),
    'evidence',jsonb_build_object('reasonCodes','impact','questionId','private-answer-q1',
      'fieldName','impact','templateVersion','question.impact.v1','questionText','impact'),
    'expectedRevision',0,'idempotencyKey','private-answer-question'
  ));
  SELECT otl.bug_answer_revision_atomic(jsonb_build_object(
    'bugId','BUG-PRIVATE020A1','reporterId','U-PRIVATE','questionId','private-answer-q1',
    'answerDigest',repeat('c',64),'answerOpaqueRef','bugs/private020/answer.enc',
    'expectedPacketRevision',1,'idempotencyKey','private-020-answer','privacy',true,
    'sanitizedFields',jsonb_build_object('actual',canary,'expected',canary,
      'steps',jsonb_build_array(canary,canary),'location',canary,'occurredAt','2026-09-17T10:01:00Z',
      'frequency','once','impact','security_privacy'),
    'completeness',jsonb_build_object('status','awaiting_confirmation'),
    'opaqueRef','bugs/private020/answer.enc','objectDigest',repeat('d',64),
    'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321'
  )) INTO answered;
  SELECT concat_ws('|',to_jsonb(r)::text,string_agg(rev.sanitized_fields::text,'|'),
    coalesce((SELECT string_agg(q.question_text||coalesce(q.completeness::text,''),'|')
      FROM otl.bug_questions q WHERE q.bug_id=r.bug_id),'')) INTO relational
  FROM otl.bug_reports r JOIN otl.bug_report_revisions rev USING(bug_id)
  WHERE r.bug_id='BUG-PRIVATE020A1' GROUP BY r.bug_id;
  IF answered->>'packet_revision'<>'2'
     OR (SELECT state<>'private_incident' OR revision<>2 OR packet_revision<>2 OR NOT privacy
       FROM otl.bug_reports WHERE bug_id='BUG-PRIVATE020A1')
     OR relational LIKE '%'||canary||'%'
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-PRIVATE020A1'
       AND to_state='private_incident' AND guard_code='private')<>1
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-PRIVATE020A1'
       AND packet_revision=2 AND delivery_kind IN ('receipt','admin_handoff'))<>2
     OR EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id='BUG-PRIVATE020A1')
  THEN RAISE EXCEPTION 'private answer was not atomic, scrubbed, and job-free'; END IF;
END $$;

DO $$
DECLARE reconciled jsonb; claimed jsonb; canary text:='CANARY-LEGACY-PRIVATE-020';
BEGIN
  PERFORM otl.bug_create_draft(jsonb_build_object(
    'bugId','BUG-PRIVATE020L1','teamId','T-PRIVATE-020','publicAlias','B-PRIVATE020L10',
    'reporterId','U-PRIVATE','source','slack','sourceOpaqueRef','slack:T-PRIVATE-020:C:3',
    'sourceChannelId','C-PRIVATE','sourceThread','3.1','idempotencyKey','private-020-legacy',
    'sanitizedFields',jsonb_build_object('title',canary,'actual',canary,'steps','[]'::jsonb,'privacy',true),
    'opaqueRef','bugs/private020/legacy.enc','objectDigest',repeat('e',64),
    'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'
  ));
  SELECT otl.bug_reconcile_private_incidents(jsonb_build_object(
    'teamId','T-PRIVATE-020','limit',10,'now','2026-09-17T12:00:00Z'
  )) INTO reconciled;
  IF reconciled<>'1'::jsonb OR (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-PRIVATE020L1')<>'private_incident'
     OR EXISTS(SELECT 1 FROM otl.bug_reports WHERE bug_id='BUG-PRIVATE020L1' AND to_jsonb(bug_reports)::text LIKE '%'||canary||'%')
     OR EXISTS(SELECT 1 FROM otl.bug_report_revisions WHERE bug_id='BUG-PRIVATE020L1' AND sanitized_fields::text LIKE '%'||canary||'%')
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-PRIVATE020L1')<>2
     OR EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id='BUG-PRIVATE020L1')
  THEN RAISE EXCEPTION 'legacy private reconciliation failed'; END IF;
  IF otl.bug_reconcile_private_incidents(jsonb_build_object(
    'teamId','T-PRIVATE-020','limit',10,'now','2026-09-17T12:01:00Z'))<>'0'::jsonb
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-PRIVATE020L1' AND to_state='private_incident')<>1
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-PRIVATE020L1')<>2
  THEN RAISE EXCEPTION 'legacy reconciliation replay was not idempotent'; END IF;
  SELECT otl.bug_claim_delivery(jsonb_build_object(
    'teamId','T-PRIVATE-020','bugId','BUG-PRIVATE020L1','reporterId','U-PRIVATE',
    'deliveryKey','BUG-PRIVATE020L1:1:receipt:reporter_ephemeral',
    'workerId','private-immediate','leaseToken','private-immediate-lease','leaseSeconds',300,
    'now','2026-09-17T12:02:00Z'
  )) INTO claimed;
  IF claimed->>'status'<>'claimed' OR claimed->>'delivery_kind'<>'receipt'
  THEN RAISE EXCEPTION 'private receipt direct claim was rejected'; END IF;
END $$;

SELECT jsonb_build_object(
  'privateDraftAtomic',true,'privateAnswerAtomic',true,'legacyReconcileOnce',true,
  'jobsZero',NOT EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id LIKE 'BUG-PRIVATE020%'),
  'canaryAbsent',NOT EXISTS(
    SELECT 1 FROM otl.bug_report_revisions WHERE bug_id LIKE 'BUG-PRIVATE020%'
      AND sanitized_fields::text LIKE '%CANARY-%'
  )
);
ROLLBACK;
