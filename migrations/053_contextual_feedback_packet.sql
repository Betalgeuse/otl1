BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE otl.bug_report_revisions
  DROP CONSTRAINT bug_report_revisions_schema_version_check,
  DROP CONSTRAINT bug_report_revisions_check;
ALTER TABLE otl.bug_report_revisions
  ADD CONSTRAINT bug_report_revisions_schema_version_check
    CHECK (schema_version IN ('bug_intake.v1','bug_packet.v1','feedback_packet.v1')),
  ADD CONSTRAINT bug_report_revisions_confirmed_schema_check
    CHECK ((status='confirmed')=(schema_version IN ('bug_packet.v1','feedback_packet.v1')));

CREATE FUNCTION otl.bug_confirm_feedback_packet(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE
  r otl.bug_reports;
  next_revision integer;
  claimed_revision integer;
  claimed_operation text;
  packet jsonb:=p->'packet';
  storage jsonb:=p->'storage';
  f jsonb:=packet->'fields';
  confirmation jsonb:=packet->'confirmation';
  source_metadata jsonb:=packet->'source';
  canonical_text text:=storage->>'canonicalPacket';
  canonical_evidence_text text:=storage->>'canonicalEvidence';
  canonical_packet jsonb;
  canonical_evidence jsonb;
  unsigned_packet jsonb;
  computed_digest text;
  rev otl.bug_report_revisions;
BEGIN
  IF jsonb_typeof(packet)<>'object' OR jsonb_typeof(storage)<>'object'
     OR coalesce(storage->>'idempotencyKey','')='' OR coalesce(canonical_text,'')=''
     OR coalesce(canonical_evidence_text,'')=''
  THEN RAISE EXCEPTION 'feedback confirmation envelope required' USING ERRCODE='22023'; END IF;
  BEGIN
    canonical_packet:=canonical_text::jsonb;
    canonical_evidence:=canonical_evidence_text::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid canonical feedback packet' USING ERRCODE='22023';
  END;
  unsigned_packet:=packet-'packetDigest';
  computed_digest:=encode(public.digest(convert_to(canonical_text,'UTF8'),'sha256'),'hex');
  IF canonical_packet<>unsigned_packet OR canonical_text<>otl.bug_canonical_json(unsigned_packet)
     OR computed_digest IS DISTINCT FROM packet->>'packetDigest'
     OR jsonb_typeof(canonical_evidence)<>'array'
     OR canonical_evidence_text<>otl.bug_canonical_json(canonical_evidence)
     OR encode(public.digest(convert_to(canonical_evidence_text,'UTF8'),'sha256'),'hex')
       IS DISTINCT FROM packet->>'evidenceDigest'
     OR coalesce(storage->>'evidenceObjectDigest','') !~ '^[0-9a-f]{64}$'
     OR storage->>'evidenceObjectDigest' IS DISTINCT FROM storage->>'objectDigest'
  THEN RAISE EXCEPTION 'invalid confirmed feedback binding' USING ERRCODE='22023'; END IF;

  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=packet->>'bugId' FOR UPDATE;
  SELECT packet_revision,operation INTO claimed_revision,claimed_operation
  FROM otl.bug_revision_claims
  WHERE bug_id=packet->>'bugId' AND idempotency_key=storage->>'idempotencyKey';
  IF FOUND THEN
    IF claimed_operation<>'confirm' THEN RAISE EXCEPTION 'idempotency operation mismatch' USING ERRCODE='22023'; END IF;
    SELECT * INTO rev FROM otl.bug_report_revisions
    WHERE bug_id=packet->>'bugId' AND packet_revision=claimed_revision;
    IF rev.confirmed_packet IS DISTINCT FROM packet
       OR rev.opaque_ref IS DISTINCT FROM storage->>'opaqueRef'
       OR rev.object_digest IS DISTINCT FROM storage->>'objectDigest'
       OR rev.evidence_object_digest IS DISTINCT FROM storage->>'evidenceObjectDigest'
    THEN RAISE EXCEPTION 'feedback confirmation idempotency mismatch' USING ERRCODE='22023'; END IF;
    RETURN rev.confirmed_packet;
  END IF;
  next_revision:=r.packet_revision+1;
  IF r.bug_id IS NULL OR r.team_id<>storage->>'teamId' OR r.reporter_id<>storage->>'reporterId'
     OR r.packet_revision<>(storage->>'expectedPacketRevision')::integer
     OR packet->>'schemaVersion'<>'feedback_packet.v1' OR packet->>'status'<>'confirmed'
     OR coalesce((confirmation->>'reporterConfirmed')::boolean,false) IS NOT TRUE
     OR packet->>'bugId'<>r.bug_id OR source_metadata->>'opaqueRef'<>r.source_opaque_ref
     OR jsonb_typeof(packet->'revision')<>'number' OR (packet->>'revision')::integer<>next_revision
     OR coalesce(packet->>'packetDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(packet->>'evidenceDigest','') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(f)<>'object' OR NOT (f ?& ARRAY['actual','expected'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['actual','expected']))
     OR jsonb_typeof(f->'actual')<>'string' OR length(trim(f->>'actual')) NOT BETWEEN 1 AND 1000
     OR jsonb_typeof(f->'expected')<>'string' OR length(trim(f->>'expected')) NOT BETWEEN 1 AND 1000
     OR jsonb_typeof(confirmation)<>'object'
     OR NOT (confirmation ?& ARRAY['reporterConfirmed','confirmedAt'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(confirmation) k WHERE NOT k=ANY(ARRAY['reporterConfirmed','confirmedAt']))
     OR jsonb_typeof(source_metadata)<>'object' OR NOT (source_metadata ?& ARRAY['kind','opaqueRef'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(source_metadata) k WHERE NOT k=ANY(ARRAY['kind','opaqueRef']))
     OR coalesce(source_metadata->>'kind','')='' OR coalesce(confirmation->>'confirmedAt','')=''
     OR coalesce(storage->>'opaqueRef','')=''
     OR coalesce(storage->>'objectDigest','') !~ '^[0-9a-f]{64}$'
     OR NOT (packet ?& ARRAY['schemaVersion','bugId','status','revision','fields','confirmation','source','evidenceDigest','packetDigest'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(packet) k WHERE NOT k=ANY(ARRAY['schemaVersion','bugId','status','revision','fields','confirmation','source','evidenceDigest','packetDigest']))
  THEN RAISE EXCEPTION 'invalid confirmed feedback packet' USING ERRCODE='22023'; END IF;
  INSERT INTO otl.bug_report_revisions(
    bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,
    envelope_dek,kek_version,nonce,evidence_digest,evidence_object_digest,packet_digest,
    reporter_confirmed,confirmed_at,confirmed_packet
  ) VALUES(
    r.bug_id,next_revision,'feedback_packet.v1','confirmed',f,storage->>'opaqueRef',storage->>'objectDigest',
    storage->>'envelopeDek',storage->>'kekVersion',storage->>'nonce',packet->>'evidenceDigest',
    storage->>'evidenceObjectDigest',packet->>'packetDigest',true,
    (confirmation->>'confirmedAt')::timestamptz,packet
  ) RETURNING * INTO rev;
  UPDATE otl.bug_reports SET
    packet_revision=next_revision,confirmed_packet_digest=packet->>'packetDigest',
    confirmed_evidence_digest=packet->>'evidenceDigest',actual=f->>'actual',expected=f->>'expected',
    updated_at=clock_timestamp()
  WHERE bug_id=r.bug_id;
  INSERT INTO otl.bug_revision_claims VALUES(r.bug_id,storage->>'idempotencyKey','confirm',next_revision);
  RETURN packet;
END $$;

REVOKE ALL ON FUNCTION otl.bug_confirm_feedback_packet(jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('053-contextual-feedback-packet');
COMMIT;
