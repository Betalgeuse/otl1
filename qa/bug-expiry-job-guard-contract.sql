\set QUIET 1
BEGIN;

CREATE FUNCTION pg_temp.expiry_report(
  id text,
  started_at timestamptz,
  questions integer DEFAULT 1,
  source_state text DEFAULT 'needs_info'
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO otl.bug_reports(
    bug_id,team_id,public_alias,reporter_id,source,source_opaque_ref,
    source_channel_id,source_thread,title,state,needs_info_started_at,question_count
  ) VALUES(
    id,'T-EXPIRY','B-'||replace(id,'BUG-','')||'00','U-REPORTER','slack','slack:T-EXPIRY:C-EXPIRY:'||id,
    'C-EXPIRY','1700000000.000001','sanitized',source_state,started_at,questions
  );
  INSERT INTO otl.bug_report_revisions(
    bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,
    object_digest,envelope_dek,kek_version,nonce
  ) VALUES(
    id,1,'bug_intake.v1','draft',jsonb_build_object('title','sanitized','actual','observed'),
    'bugs/'||id||'/revision-1.enc',repeat(substr(md5(id),1,1),64),'encrypted-envelope','v1','nonce-123456'
  );
END $$;

SELECT pg_temp.expiry_report('BUG-EXPIRY0001','2026-09-16T12:00:00Z',1);
SELECT pg_temp.expiry_report('BUG-EXPIRY0002','2026-09-16T12:00:00.000001Z',1);
SELECT pg_temp.expiry_report('BUG-EXPIRY0003','2026-09-17T11:59:59Z',5);
INSERT INTO otl.bug_questions(
  bug_id,question_id,field_name,template_version,question_text,asked_packet_revision
) VALUES('BUG-EXPIRY0001','expiry-q1','expected','question.expected.v1','sanitized',1);

DO $$
DECLARE expired jsonb;
BEGIN
  SELECT otl.bug_expire_due_intakes(jsonb_build_object(
    'teamId','T-EXPIRY','now','2026-09-17T12:00:00Z','limit',10
  )) INTO expired;
  IF expired <> '2'::jsonb THEN RAISE EXCEPTION 'expected two expiries, got %',expired; END IF;
  IF (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-EXPIRY0001') <> 'needs_info_exhausted'
     OR (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-EXPIRY0003') <> 'needs_info_exhausted'
     OR (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-EXPIRY0002') <> 'needs_info'
  THEN RAISE EXCEPTION '24h boundary or five-question cap failed'; END IF;
  IF (SELECT count(*) FROM otl.bug_events WHERE bug_id IN ('BUG-EXPIRY0001','BUG-EXPIRY0003')) <> 2
     OR EXISTS(
       SELECT 1 FROM otl.bug_events
       WHERE bug_id IN ('BUG-EXPIRY0001','BUG-EXPIRY0003')
         AND (actors <> '["scheduler"]'::jsonb OR guard_code <> 'exhausted'
              OR evidence->>'conversationDigest' IS NULL
              OR evidence->>'exhaustionReason' NOT IN ('24h','five'))
     )
  THEN RAISE EXCEPTION 'system timer event mismatch'; END IF;
  IF (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id IN ('BUG-EXPIRY0001','BUG-EXPIRY0003')) <> 4
     OR EXISTS(
       SELECT 1 FROM otl.bug_deliveries d
       JOIN otl.bug_reports r USING(bug_id)
       WHERE d.bug_id IN ('BUG-EXPIRY0001','BUG-EXPIRY0003')
         AND (r.team_id <> 'T-EXPIRY' OR r.reporter_id <> 'U-REPORTER'
              OR (d.delivery_kind='receipt' AND d.destination<>'reporter_ephemeral')
              OR (d.delivery_kind='admin_handoff' AND d.destination<>'admin_channel')
              OR d.delivery_key <> d.bug_id||':'||d.packet_revision||':'||d.delivery_kind||':'||d.destination)
     )
  THEN RAISE EXCEPTION 'transactional expiry outbox mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id LIKE 'BUG-EXPIRY%')
  THEN RAISE EXCEPTION 'expiry created agent jobs'; END IF;
  BEGIN
    PERFORM otl.bug_answer_revision(jsonb_build_object(
      'bugId','BUG-EXPIRY0001','reporterId','U-REPORTER','questionId','expiry-q1',
      'answerDigest',repeat('2',64),'answerOpaqueRef','bugs/answer.enc',
      'expectedPacketRevision',1,'idempotencyKey','late-answer',
      'sanitizedFields',jsonb_build_object(
        'actual','observed','expected','wanted','steps',jsonb_build_array('one','two'),
        'location','channel','occurredAt','2026-09-17T10:00:00Z','frequency','once','impact','blocked'
      ),
      'completeness',jsonb_build_object('status','awaiting_confirmation'),
      'opaqueRef','bugs/late-answer.enc','objectDigest',repeat('3',64),
      'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'
    ));
    RAISE EXCEPTION 'late reporter answer won after scheduler expiry';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  IF (SELECT count(*) FROM otl.bug_report_revisions WHERE bug_id='BUG-EXPIRY0001')<>1
  THEN RAISE EXCEPTION 'late reporter answer wrote a revision'; END IF;
  SELECT otl.bug_expire_due_intakes(jsonb_build_object(
    'teamId','T-EXPIRY','now','2026-09-17T12:00:00Z','limit',10
  )) INTO expired;
  IF expired <> '0'::jsonb
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id IN ('BUG-EXPIRY0001','BUG-EXPIRY0003')) <> 2
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id IN ('BUG-EXPIRY0001','BUG-EXPIRY0003')) <> 4
  THEN RAISE EXCEPTION 'expiry replay was not idempotent'; END IF;
END $$;

SELECT pg_temp.expiry_report('BUG-EXPIRY0004','2026-09-16T11:00:00Z',1);
CREATE FUNCTION pg_temp.reject_expiry_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bug_id='BUG-EXPIRY0004' THEN RAISE EXCEPTION 'fault injected outbox rejection'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qa_reject_expiry_delivery BEFORE INSERT ON otl.bug_deliveries
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_expiry_delivery();
DO $$
BEGIN
  BEGIN
    PERFORM otl.bug_expire_due_intakes(jsonb_build_object('teamId','T-EXPIRY','now','2026-09-17T12:00:00Z','limit',10));
    RAISE EXCEPTION 'fault injection did not fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='fault injection did not fail' THEN RAISE; END IF;
  END;
  IF (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-EXPIRY0004') <> 'needs_info'
     OR EXISTS(SELECT 1 FROM otl.bug_events WHERE bug_id='BUG-EXPIRY0004')
     OR EXISTS(SELECT 1 FROM otl.bug_deliveries WHERE bug_id='BUG-EXPIRY0004')
  THEN RAISE EXCEPTION 'expiry state escaped failed outbox transaction'; END IF;
END $$;
DROP TRIGGER qa_reject_expiry_delivery ON otl.bug_deliveries;

DO $$
DECLARE state_name text; kind_name text; id text; seq integer:=0; denied integer:=0;
BEGIN
  FOREACH state_name IN ARRAY ARRAY['new','needs_info','needs_info_exhausted','triaged','queued','reproduced','fixing','reviewing','merged'] LOOP
    seq:=seq+1;
    id:='BUG-JOB'||lpad(seq::text,8,'0');
    PERFORM pg_temp.expiry_report(id,'2026-09-17T12:00:00Z',0,state_name);
    IF state_name NOT IN ('new','needs_info','needs_info_exhausted') THEN
      UPDATE otl.bug_reports SET confirmed_packet_digest=repeat('a',64),confirmed_evidence_digest=repeat('b',64) WHERE bug_id=id;
    END IF;
    FOREACH kind_name IN ARRAY ARRAY['reproduce','fix','review','deploy'] LOOP
      BEGIN
        PERFORM otl.bug_enqueue_job(jsonb_build_object(
          'bugId',id,'kind',kind_name,'payload','{}'::jsonb,'payloadDigest',repeat('c',64)
        ));
        RAISE EXCEPTION 'direct job enqueue accepted for %/%',state_name,kind_name;
      EXCEPTION WHEN insufficient_privilege THEN denied:=denied+1; END;
    END LOOP;
  END LOOP;
  IF denied<>36 OR EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id LIKE 'BUG-JOB%')
  THEN RAISE EXCEPTION 'direct job guard failed: %',denied; END IF;
END $$;

SELECT pg_temp.expiry_report('BUG-ALLOWED001','2026-09-17T12:00:00Z',0,'triaged');
UPDATE otl.bug_reports SET confirmed_packet_digest=repeat('d',64),confirmed_evidence_digest=repeat('e',64)
WHERE bug_id='BUG-ALLOWED001';
UPDATE otl.bug_report_revisions SET
  schema_version='bug_packet.v1',status='confirmed',evidence_digest=repeat('e',64),packet_digest=repeat('d',64),
  confirmed_packet=jsonb_build_object('schemaVersion','bug_packet.v1'),reporter_confirmed=true,confirmed_at='2026-09-17T11:00:00Z'
WHERE bug_id='BUG-ALLOWED001' AND packet_revision=1;
SELECT otl.bug_transition(jsonb_build_object(
  'bugId','BUG-ALLOWED001','toState','queued','actors',jsonb_build_array('admin'),
  'guard',jsonb_build_object('classified',true,'notPaused',true),
  'evidence',jsonb_build_object('triageReceipt','receipt','baseSha',repeat('f',40),'payloadDigest',repeat('1',64)),
  'expectedRevision',0,'idempotencyKey','allowed-confirmed-queue','now','2026-09-17T12:00:00Z'
));
DO $$
BEGIN
  IF (SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-ALLOWED001' AND kind='reproduce' AND event_id IS NOT NULL)<>1
  THEN RAISE EXCEPTION 'confirmed transition did not create exactly one reproduce job'; END IF;
END $$;

SELECT jsonb_build_object(
  'expiryBoundary',true,
  'questionCap',true,
  'transactionalOutbox',true,
  'replayIdempotent',true,
  'jobsZeroBeforeConfirmation',true,
  'confirmedTransitionJob',true
);
ROLLBACK;
