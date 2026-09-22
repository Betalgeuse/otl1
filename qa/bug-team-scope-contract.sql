\set QUIET 1
BEGIN;

CREATE FUNCTION pg_temp.team_report(id text,team text,started_at timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO otl.bug_reports(
    bug_id,team_id,public_alias,reporter_id,source,source_opaque_ref,
    source_channel_id,source_thread,title,state,needs_info_started_at,question_count
  ) VALUES(
    id,team,'B-'||replace(id,'BUG-','')||'0','U-'||team,'slack','slack:'||team||':C:'||id,
    'C-'||team,'1700000000.000001','fixture','needs_info',started_at,1
  );
  INSERT INTO otl.bug_report_revisions(
    bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,
    object_digest,envelope_dek,kek_version,nonce
  ) VALUES(
    id,1,'bug_intake.v1','draft',jsonb_build_object('title','fixture','actual','observed'),
    'bugs/'||id||'/revision-1.enc',repeat(substr(md5(id),1,1),64),'encrypted-envelope','v1','nonce-123456'
  );
END $$;

SELECT pg_temp.team_report('BUG-TEAMEXPIRYA1','T-TEAM-A','2026-09-16T12:00:00Z');
SELECT pg_temp.team_report('BUG-TEAMEXPIRYB1','T-TEAM-B','2026-09-16T12:00:00Z');

DO $$
DECLARE expired jsonb;
BEGIN
  SELECT otl.bug_expire_due_intakes(jsonb_build_object(
    'teamId','T-TEAM-A','now','2026-09-17T12:00:00Z','limit',10
  )) INTO expired;
  IF expired<>'1'::jsonb
     OR (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-TEAMEXPIRYA1')<>'needs_info_exhausted'
     OR (SELECT state FROM otl.bug_reports WHERE bug_id='BUG-TEAMEXPIRYB1')<>'needs_info'
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-TEAMEXPIRYA1')<>1
     OR EXISTS(SELECT 1 FROM otl.bug_events WHERE bug_id='BUG-TEAMEXPIRYB1')
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-TEAMEXPIRYA1')<>2
     OR EXISTS(SELECT 1 FROM otl.bug_deliveries WHERE bug_id='BUG-TEAMEXPIRYB1')
  THEN RAISE EXCEPTION 'team-scoped expiry crossed tenant boundary'; END IF;
  BEGIN
    PERFORM otl.bug_expire_due_intakes(jsonb_build_object(
      'teamId','../other','now','2026-09-17T12:00:00Z','limit',10));
    RAISE EXCEPTION 'invalid expiry team accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

DELETE FROM otl.bug_deliveries WHERE bug_id='BUG-TEAMEXPIRYA1';
SELECT pg_temp.team_report('BUG-TEAMCLAIMA01','T-TEAM-A','2026-09-17T12:00:00Z');
SELECT pg_temp.team_report('BUG-TEAMCLAIMB01','T-TEAM-B','2026-09-17T12:00:00Z');
INSERT INTO otl.bug_questions(
  bug_id,question_id,field_name,template_version,question_text,asked_packet_revision
) VALUES
  ('BUG-TEAMCLAIMA01','team-a-q1','actual','question.actual.v1','fixture',1),
  ('BUG-TEAMCLAIMB01','team-b-q1','actual','question.actual.v1','fixture',1);
INSERT INTO otl.bug_deliveries(
  delivery_key,delivery_kind,team_id,bug_id,packet_revision,question_id,destination,
  template_id,field_name,renderer_version,not_before
) VALUES
  ('BUG-TEAMCLAIMA01:1:question:reporter_thread','question','T-TEAM-A','BUG-TEAMCLAIMA01',1,
   'team-a-q1','reporter_thread','question.actual.v1','actual','bug-question.v1','2026-09-17T12:00:00Z'),
  ('BUG-TEAMCLAIMB01:1:question:reporter_thread','question','T-TEAM-B','BUG-TEAMCLAIMB01',1,
   'team-b-q1','reporter_thread','question.actual.v1','actual','bug-question.v1','2026-09-17T12:00:00Z');

DO $$
DECLARE claimed jsonb;
BEGIN
  SELECT otl.bug_claim_due_deliveries(jsonb_build_object(
    'teamId','T-TEAM-A','workerId','team-a-worker','leaseToken','team-a-lease',
    'leaseSeconds',300,'limit',10,'now','2026-09-17T12:01:00Z'
  )) INTO claimed;
  IF jsonb_array_length(claimed)<>1 OR claimed#>>'{0,team_id}'<>'T-TEAM-A'
     OR claimed#>>'{0,bug_id}'<>'BUG-TEAMCLAIMA01'
     OR (SELECT status FROM otl.bug_deliveries WHERE bug_id='BUG-TEAMCLAIMB01')<>'pending'
     OR (SELECT attempts FROM otl.bug_deliveries WHERE bug_id='BUG-TEAMCLAIMB01')<>0
  THEN RAISE EXCEPTION 'team-scoped claim crossed tenant boundary: %',claimed; END IF;
  SELECT otl.bug_claim_due_deliveries(jsonb_build_object(
    'teamId','T-TEAM-B','workerId','team-b-worker','leaseToken','team-b-lease',
    'leaseSeconds',300,'limit',10,'now','2026-09-17T12:01:00Z'
  )) INTO claimed;
  IF jsonb_array_length(claimed)<>1 OR claimed#>>'{0,team_id}'<>'T-TEAM-B'
     OR claimed#>>'{0,bug_id}'<>'BUG-TEAMCLAIMB01'
  THEN RAISE EXCEPTION 'team B could not claim its own delivery: %',claimed; END IF;
  BEGIN
    PERFORM otl.bug_claim_due_deliveries(jsonb_build_object(
      'teamId',' ','workerId','invalid','leaseToken','invalid','limit',10,
      'now','2026-09-17T12:01:00Z'));
    RAISE EXCEPTION 'invalid claim team accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

SELECT jsonb_build_object(
  'teamScopedExpiry',true,'teamScopedClaims',true,'crossTeamRowsUntouched',true,
  'teamLeadingIndex',position('(team_id, status' in pg_get_indexdef('otl.bug_deliveries_global_due'::regclass))>0
);
ROLLBACK;
