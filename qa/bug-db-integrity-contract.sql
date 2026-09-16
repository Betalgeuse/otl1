\set QUIET 1
BEGIN;

CREATE FUNCTION pg_temp.qa_integrity_report(id text,state_name text DEFAULT 'new') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO otl.bug_reports(
    bug_id,team_id,public_alias,reporter_id,source,source_opaque_ref,
    source_channel_id,source_thread,title,state
  ) VALUES(
    id,'T-INTEGRITY','B-'||replace(id,'BUG-','')||'0','U-INTEGRITY','slack',
    'slack:T-INTEGRITY:C-INTEGRITY:'||id,'C-INTEGRITY','1700000000.000001','fixture',state_name
  );
  INSERT INTO otl.bug_report_revisions(
    bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,
    object_digest,envelope_dek,kek_version,nonce
  ) VALUES(
    id,1,'bug_intake.v1','draft',jsonb_build_object(
      'title','fixture','actual','observed','expected','wanted','steps',jsonb_build_array('one','two'),
      'location','channel','occurredAt','2026-09-17T10:00:00+09:00','frequency','once','impact','blocked'
    ),'bugs/'||id||'/revision-1.enc',repeat('a',64),'encrypted-envelope','v1','nonce-123456'
  );
END $$;

DO $$
DECLARE job jsonb; leased jsonb; finished jsonb; replay jsonb;
BEGIN
  PERFORM pg_temp.qa_integrity_report('BUG-LEASE000001','triaged');
  UPDATE otl.bug_reports SET confirmed_packet_digest=repeat('b',64),confirmed_evidence_digest=repeat('c',64)
  WHERE bug_id='BUG-LEASE000001';
  INSERT INTO otl.bug_jobs(bug_id,kind,payload,payload_digest,assigned_alias,available_at)
  VALUES('BUG-LEASE000001','reproduce','{}',repeat('d',64),'alias-a','2026-09-17T10:00:00Z') RETURNING to_jsonb(otl.bug_jobs.*) INTO job;
  SELECT otl.bug_lease_job(jsonb_build_object(
    'workerId','worker-a','accountAlias','alias-a','leaseToken','lease-a','kinds',jsonb_build_array('reproduce'),
    'leaseSeconds',30,'now','2026-09-17T10:00:00Z')) INTO leased;
  IF leased->>'attempt'<>'1' THEN RAISE EXCEPTION 'initial lease failed'; END IF;
  IF otl.bug_lease_job(jsonb_build_object(
    'workerId','worker-a','accountAlias','alias-a','leaseToken','lease-a','kinds',jsonb_build_array('reproduce'),
    'leaseSeconds',30,'now','2026-09-17T10:00:31Z'))->>'attempt'<>'2'
  THEN RAISE EXCEPTION 'expired matching holder reentered without reclaim'; END IF;
  BEGIN
    PERFORM otl.bug_finish_job(jsonb_build_object(
      'jobId',(leased->>'job_id')::bigint,'workerId','worker-a','leaseToken','lease-a','status','succeeded',
      'resultDigest',repeat('e',64),'now','2026-09-17T10:01:02Z'));
    RAISE EXCEPTION 'expired holder finished job';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  BEGIN
    PERFORM otl.bug_finish_job(jsonb_build_object(
      'jobId',(leased->>'job_id')::bigint,'workerId','worker-b','leaseToken','lease-a','status','succeeded',
      'resultDigest',repeat('e',64),'now','2026-09-17T10:00:32Z'));
    RAISE EXCEPTION 'wrong worker finished job';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  INSERT INTO otl.bug_jobs(bug_id,kind,payload,payload_digest,assigned_alias,available_at)
  VALUES('BUG-LEASE000001','review','{}',repeat('f',64),'alias-b','2026-09-17T11:00:00Z');
  SELECT otl.bug_lease_job(jsonb_build_object(
    'workerId','worker-b','accountAlias','alias-b','leaseToken','lease-b','kinds',jsonb_build_array('review'),
    'leaseSeconds',30,'now','2026-09-17T11:00:00Z')) INTO leased;
  SELECT otl.bug_finish_job(jsonb_build_object(
    'jobId',(leased->>'job_id')::bigint,'workerId','worker-b','leaseToken','lease-b','status','succeeded',
    'resultDigest',repeat('9',64),'now','2026-09-17T11:00:01Z')) INTO finished;
  SELECT otl.bug_finish_job(jsonb_build_object(
    'jobId',(leased->>'job_id')::bigint,'workerId','worker-b','leaseToken','lease-b','status','succeeded',
    'resultDigest',repeat('9',64),'now','2026-09-17T11:00:02Z')) INTO replay;
  IF finished->>'status'<>'succeeded' OR replay->>'status'<>'succeeded'
  THEN RAISE EXCEPTION 'owned unexpired finish or replay failed'; END IF;
END $$;

DO $$
BEGIN
  PERFORM pg_temp.qa_integrity_report('BUG-RESET000001','needs_info');
  UPDATE otl.bug_reports SET question_count=5,needs_info_started_at='2026-09-17T09:00:00Z'
  WHERE bug_id='BUG-RESET000001';
  PERFORM otl.bug_transition(jsonb_build_object(
    'bugId','BUG-RESET000001','toState','needs_info_exhausted','actors',jsonb_build_array('scheduler'),
    'guard',jsonb_build_object('exhausted',true),
    'evidence',jsonb_build_object('conversationDigest',repeat('1',64),'exhaustionReason','five'),
    'expectedRevision',0,'idempotencyKey','reset-exhaust','now','2026-09-17T10:00:00Z'));
  PERFORM otl.bug_transition(jsonb_build_object(
    'bugId','BUG-RESET000001','toState','needs_info','actors',jsonb_build_array('admin'),
    'guard',jsonb_build_object('newEvidenceRequired',true),
    'evidence',jsonb_build_object('adminReason','new evidence','questionId','reset-q6','fieldName','actual'),
    'expectedRevision',1,'idempotencyKey','reset-once','now','2026-09-17T10:01:00Z'));
  IF (SELECT question_count<>1 OR needs_info_reset_count<>1 FROM otl.bug_reports WHERE bug_id='BUG-RESET000001')
     OR (SELECT count(*) FROM otl.bug_questions WHERE bug_id='BUG-RESET000001')<>1
  THEN RAISE EXCEPTION 'natural five-question reset failed'; END IF;
  UPDATE otl.bug_reports SET state='needs_info_exhausted',revision=3,question_count=5 WHERE bug_id='BUG-RESET000001';
  BEGIN
    PERFORM otl.bug_transition(jsonb_build_object(
      'bugId','BUG-RESET000001','toState','needs_info','actors',jsonb_build_array('admin'),
      'guard',jsonb_build_object('newEvidenceRequired',true),
      'evidence',jsonb_build_object('adminReason','again','questionId','reset-q7'),
      'expectedRevision',3,'idempotencyKey','reset-twice'));
    RAISE EXCEPTION 'second reset accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

DO $$
DECLARE unsigned_packet jsonb; packet jsonb; canonical text; canonical_evidence text:='[]'; digest text; evidence_digest text;
  bad_unsigned jsonb; bad_packet jsonb; bad_canonical text; bad_digest text;
BEGIN
  PERFORM pg_temp.qa_integrity_report('BUG-CONFIRM0001');
  unsigned_packet:=jsonb_build_object(
    'schemaVersion','bug_packet.v1','bugId','BUG-CONFIRM0001','status','confirmed','revision',2,
    'fields',jsonb_build_object('actual','observed','expected','wanted','steps',jsonb_build_array('one','two'),
      'location','channel','occurredAt','2026-09-17T10:00:00+09:00','frequency','once','impact','blocked'),
    'confirmation',jsonb_build_object('reporterConfirmed',true,'confirmedAt','2026-09-17T10:02:00+09:00'),
    'source',jsonb_build_object('kind','slack','opaqueRef','slack:T-INTEGRITY:C-INTEGRITY:BUG-CONFIRM0001'),
    'evidenceDigest','pending'
  );
  evidence_digest:=encode(public.digest(convert_to(canonical_evidence,'UTF8'),'sha256'),'hex');
  unsigned_packet:=jsonb_set(unsigned_packet,'{evidenceDigest}',to_jsonb(evidence_digest));
  canonical:=otl.bug_canonical_json(unsigned_packet);
  digest:=encode(public.digest(convert_to(canonical,'UTF8'),'sha256'),'hex');
  packet:=unsigned_packet||jsonb_build_object('packetDigest',digest);
  PERFORM otl.bug_confirm_packet(jsonb_build_object(
    'packet',packet,'storage',jsonb_build_object(
      'teamId','T-INTEGRITY','reporterId','U-INTEGRITY','expectedPacketRevision',1,
      'idempotencyKey','confirm-valid','opaqueRef','bugs/BUG-CONFIRM0001/revision-2.enc',
      'objectDigest',repeat('2',64),'evidenceObjectDigest',repeat('2',64),'canonicalEvidence',canonical_evidence,
      'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321','canonicalPacket',canonical)));
  IF (SELECT packet_revision<>2 OR evidence_object_digest<>repeat('2',64)
      FROM otl.bug_report_revisions WHERE bug_id='BUG-CONFIRM0001' AND packet_revision=2)
  THEN RAISE EXCEPTION 'confirmed revision binding failed'; END IF;

  PERFORM pg_temp.qa_integrity_report('BUG-CONFIRM0002');
  bad_unsigned:=jsonb_set(jsonb_set(unsigned_packet,'{bugId}','"BUG-CONFIRM0002"'),'{revision}','99');
  bad_canonical:=otl.bug_canonical_json(bad_unsigned);
  bad_digest:=encode(public.digest(convert_to(bad_canonical,'UTF8'),'sha256'),'hex');
  bad_packet:=bad_unsigned||jsonb_build_object('packetDigest',bad_digest);
  BEGIN
    PERFORM otl.bug_confirm_packet(jsonb_build_object(
      'packet',bad_packet,
      'storage',jsonb_build_object('teamId','T-INTEGRITY','reporterId','U-INTEGRITY','expectedPacketRevision',1,
        'idempotencyKey','bad-revision','opaqueRef','bugs/bad.enc','objectDigest',repeat('2',64),
        'evidenceObjectDigest',repeat('2',64),'canonicalEvidence',canonical_evidence,
        'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321','canonicalPacket',bad_canonical)));
    RAISE EXCEPTION 'arbitrary packet revision accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM otl.bug_confirm_packet(jsonb_build_object(
      'packet',packet||jsonb_build_object('fields',(packet->'fields')||jsonb_build_object('actual','tampered')),
      'storage',jsonb_build_object('teamId','T-INTEGRITY','reporterId','U-INTEGRITY','expectedPacketRevision',1,
        'idempotencyKey','bad-content','opaqueRef','bugs/bad.enc','objectDigest',repeat('2',64),
        'evidenceObjectDigest',repeat('2',64),'canonicalEvidence',canonical_evidence,
        'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321','canonicalPacket',canonical)));
    RAISE EXCEPTION 'packet content digest mismatch accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM otl.bug_confirm_packet(jsonb_build_object(
      'packet',packet||jsonb_build_object('bugId','BUG-CONFIRM0002'),
      'storage',jsonb_build_object('teamId','T-INTEGRITY','reporterId','U-INTEGRITY','expectedPacketRevision',1,
        'idempotencyKey','bad-evidence','opaqueRef','bugs/bad.enc','objectDigest',repeat('2',64),
        'evidenceObjectDigest',repeat('0',64),'canonicalEvidence',canonical_evidence,
        'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321','canonicalPacket',canonical)));
    RAISE EXCEPTION 'evidence metadata mismatch accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM otl.bug_confirm_packet(jsonb_build_object(
      'packet',packet||jsonb_build_object('bugId','BUG-CONFIRM0002'),
      'storage',jsonb_build_object('teamId','T-INTEGRITY','reporterId','U-INTEGRITY','expectedPacketRevision',1,
        'idempotencyKey','bad-semantic-evidence','opaqueRef','bugs/bad.enc','objectDigest',repeat('2',64),
        'evidenceObjectDigest',repeat('2',64),'canonicalEvidence','["tampered"]',
        'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321','canonicalPacket',canonical)));
    RAISE EXCEPTION 'semantic evidence digest mismatch accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM otl.bug_confirm_packet(jsonb_build_object(
      'packet',packet||jsonb_build_object('bugId','BUG-CONFIRM0002'),
      'storage',jsonb_build_object('teamId','T-INTEGRITY','reporterId','U-INTEGRITY','expectedPacketRevision',1,
        'idempotencyKey','bad-canonical','opaqueRef','bugs/bad.enc','objectDigest',repeat('2',64),
        'evidenceObjectDigest',repeat('2',64),'canonicalEvidence',canonical_evidence,
        'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-654321','canonicalPacket','{malformed')));
    RAISE EXCEPTION 'malformed canonical packet accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

DO $$
DECLARE claimed jsonb;
BEGIN
  PERFORM pg_temp.qa_integrity_report('BUG-OBSOLETE001','needs_info');
  INSERT INTO otl.bug_questions(bug_id,question_id,field_name,template_version,question_text,asked_packet_revision)
  VALUES('BUG-OBSOLETE001','obsolete-q1','actual','question.actual.v1','fixture',1);
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,question_id,destination,
    template_id,field_name,renderer_version,not_before
  ) VALUES(
    'BUG-OBSOLETE001:1:question:reporter_thread','question','T-INTEGRITY','BUG-OBSOLETE001',1,
    'obsolete-q1','reporter_thread','question.actual.v1','actual','bug-question.v1','2026-09-17T10:00:00Z'
  );
  UPDATE otl.bug_questions SET answer_digest=repeat('3',64),answer_opaque_ref='bugs/answer.enc',
    answer_packet_revision=2,answered_at='2026-09-17T10:01:00Z' WHERE bug_id='BUG-OBSOLETE001';
  UPDATE otl.bug_reports SET packet_revision=2 WHERE bug_id='BUG-OBSOLETE001';
  INSERT INTO otl.bug_report_revisions(
    bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce
  ) SELECT bug_id,2,'bug_intake.v1','answered',sanitized_fields,'bugs/revision-2.enc',repeat('4',64),
    'encrypted-envelope','v1','nonce-654321' FROM otl.bug_report_revisions WHERE bug_id='BUG-OBSOLETE001' AND packet_revision=1;
  SELECT otl.bug_claim_due_deliveries(jsonb_build_object(
    'teamId','T-INTEGRITY','workerId','delivery-worker','leaseToken','delivery-lease','leaseSeconds',300,'limit',10,
    'now','2026-09-17T10:02:00Z')) INTO claimed;
  IF claimed<>'[]'::jsonb OR (SELECT status<>'cancelled' OR cancel_reason<>'obsolete_revision'
      FROM otl.bug_deliveries WHERE bug_id='BUG-OBSOLETE001')
  THEN RAISE EXCEPTION 'obsolete delivery was claimed'; END IF;

  PERFORM pg_temp.qa_integrity_report('BUG-OBSOLETE002','needs_info');
  INSERT INTO otl.bug_questions(bug_id,question_id,field_name,template_version,question_text,asked_packet_revision)
  VALUES('BUG-OBSOLETE002','obsolete-q2','actual','question.actual.v1','fixture',1);
  UPDATE otl.bug_questions SET answer_digest=repeat('3',64),answer_opaque_ref='bugs/answer.enc',
    answer_packet_revision=1,answered_at='2026-09-17T10:01:00Z' WHERE bug_id='BUG-OBSOLETE002';
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,question_id,destination,
    template_id,field_name,renderer_version,not_before
  ) VALUES(
    'BUG-OBSOLETE002:1:question:reporter_thread','question','T-INTEGRITY','BUG-OBSOLETE002',1,
    'obsolete-q2','reporter_thread','question.actual.v1','actual','bug-question.v1','2026-09-17T10:00:00Z'
  );

  PERFORM pg_temp.qa_integrity_report('BUG-OBSOLETE003','triaged');
  UPDATE otl.bug_report_revisions SET schema_version='bug_packet.v1',status='confirmed',
    evidence_digest=repeat('6',64),packet_digest=repeat('7',64),confirmed_packet='{}',
    reporter_confirmed=true,confirmed_at='2026-09-17T09:00:00Z' WHERE bug_id='BUG-OBSOLETE003';
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,destination,template_id,renderer_version,not_before
  ) VALUES(
    'BUG-OBSOLETE003:1:receipt:reporter_ephemeral','receipt','T-INTEGRITY','BUG-OBSOLETE003',1,
    'reporter_ephemeral','receipt.confirmed.v1','bug-receipt.v1','2026-09-17T10:00:00Z'
  );
  UPDATE otl.bug_reports SET state='queued' WHERE bug_id='BUG-OBSOLETE003';

  PERFORM pg_temp.qa_integrity_report('BUG-OBSOLETE004','new');
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,destination,template_id,renderer_version,not_before
  ) VALUES(
    'BUG-OBSOLETE004:1:summary:reporter_thread','summary','T-INTEGRITY','BUG-OBSOLETE004',1,
    'reporter_thread','summary.confirmation.v1','bug-summary.v1','2026-09-17T10:00:00Z'
  );
  UPDATE otl.bug_reports SET state='rejected' WHERE bug_id='BUG-OBSOLETE004';

  PERFORM pg_temp.qa_integrity_report('BUG-OBSOLETE005','private_incident');
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,destination,template_id,renderer_version,not_before
  ) VALUES(
    'BUG-OBSOLETE005:1:admin_handoff:admin_channel','admin_handoff','T-INTEGRITY','BUG-OBSOLETE005',1,
    'admin_channel','admin_handoff.private.v1','bug-handoff.v1','2026-09-17T10:00:00Z'
  );
  UPDATE otl.bug_reports SET state='resolved' WHERE bug_id='BUG-OBSOLETE005';

  PERFORM pg_temp.qa_integrity_report('BUG-RETRY000001','needs_info');
  INSERT INTO otl.bug_questions(bug_id,question_id,field_name,template_version,question_text,asked_packet_revision)
  VALUES('BUG-RETRY000001','retry-q1','actual','question.actual.v1','fixture',1);
  INSERT INTO otl.bug_deliveries(
    delivery_key,delivery_kind,team_id,bug_id,packet_revision,question_id,destination,
    template_id,field_name,renderer_version,status,attempts,not_before,worker_id,lease_token,lease_expires_at
  ) VALUES(
    'BUG-RETRY000001:1:question:reporter_thread','question','T-INTEGRITY','BUG-RETRY000001',1,
    'retry-q1','reporter_thread','question.actual.v1','actual','bug-question.v1','claimed',1,
    '2026-09-17T10:00:00Z','lost-worker','lost-token','2026-09-17T10:01:00Z'
  );
  SELECT otl.bug_claim_due_deliveries(jsonb_build_object(
    'teamId','T-INTEGRITY','workerId','delivery-worker','leaseToken','delivery-lease','leaseSeconds',300,'limit',10,
    'now','2026-09-17T10:02:00Z')) INTO claimed;
  IF jsonb_array_length(claimed)<>1 OR claimed#>>'{0,bug_id}'<>'BUG-RETRY000001'
     OR claimed#>>'{0,attempts}'<>'2'
  THEN RAISE EXCEPTION 'uncertain-send recovery was not preserved: %',claimed; END IF;
  IF EXISTS(SELECT 1 FROM otl.bug_deliveries WHERE bug_id LIKE 'BUG-OBSOLETE00%'
    AND status<>'cancelled')
  THEN RAISE EXCEPTION 'an obsolete delivery remained claimable'; END IF;
  IF (SELECT count(DISTINCT cancel_reason) FROM otl.bug_deliveries
      WHERE bug_id LIKE 'BUG-OBSOLETE00%')<>3
  THEN RAISE EXCEPTION 'obsolete delivery cancellation reasons were not classified'; END IF;
END $$;

DO $$
DECLARE canary text:='CANARY-PRIVATE-7f3c9a'; relational_dump text;
BEGIN
  PERFORM pg_temp.qa_integrity_report('BUG-PRIVATE0001');
  UPDATE otl.bug_reports SET title=canary,actual=canary,expected=canary,location=canary,deployed_version=canary
  WHERE bug_id='BUG-PRIVATE0001';
  UPDATE otl.bug_report_revisions SET sanitized_fields=jsonb_build_object('title',canary,'actual',canary),
    confirmed_packet=jsonb_build_object('secret',canary) WHERE bug_id='BUG-PRIVATE0001';
  INSERT INTO otl.bug_questions(bug_id,question_id,field_name,template_version,question_text,asked_packet_revision,completeness)
  VALUES('BUG-PRIVATE0001','private-q1','actual','question.actual.v1',canary,1,jsonb_build_object('secret',canary));
  PERFORM otl.bug_transition(jsonb_build_object(
    'bugId','BUG-PRIVATE0001','toState','private_incident','actors',jsonb_build_array('admin'),
    'guard',jsonb_build_object('privacyOrSecurity',true),
    'evidence',jsonb_build_object('intakeDigest',repeat('5',64)),
    'expectedRevision',0,'idempotencyKey','private-scrub'));
  SELECT concat_ws('|',to_jsonb(r)::text,coalesce(string_agg(rev.sanitized_fields::text||coalesce(rev.confirmed_packet::text,''),'|'),''),
    coalesce((SELECT string_agg(q.question_text||coalesce(q.completeness::text,''),'|') FROM otl.bug_questions q WHERE q.bug_id=r.bug_id),''))
  INTO relational_dump FROM otl.bug_reports r JOIN otl.bug_report_revisions rev USING(bug_id)
  WHERE r.bug_id='BUG-PRIVATE0001' GROUP BY r.bug_id;
  IF relational_dump LIKE '%'||canary||'%' THEN RAISE EXCEPTION 'private canary remained in relational data'; END IF;
  IF NOT EXISTS(SELECT 1 FROM otl.bug_report_revisions WHERE bug_id='BUG-PRIVATE0001'
    AND opaque_ref='bugs/BUG-PRIVATE0001/revision-1.enc' AND object_digest=repeat('a',64))
  THEN RAISE EXCEPTION 'private object reference or digest was not preserved'; END IF;
END $$;

SELECT jsonb_build_object(
  'jobLeaseOwnership',true,'naturalReset',true,'packetAdmission',true,
  'obsoleteDeliveryCancellation',true,'privateRelationalScrub',true,
  'transitionEdges',(SELECT count(*) FROM otl.bug_transition_contract),
  'globalDueIndex',to_regclass('otl.bug_deliveries_global_due') IS NOT NULL
);
ROLLBACK;
