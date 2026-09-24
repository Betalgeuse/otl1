BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE otl.bug_runner_repository_heads(
  team_id text NOT NULL, repository text NOT NULL, branch text NOT NULL,
  head_sha text NOT NULL CHECK(head_sha ~ '^[0-9a-f]{40,64}$'),
  observed_at timestamptz NOT NULL, worker_id text NOT NULL,
  PRIMARY KEY(team_id,repository,branch)
);
CREATE FUNCTION otl.bug_runner_update_head(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE h otl.bug_runner_repository_heads;
BEGIN
 IF coalesce(p->>'teamId','')='' OR coalesce(p->>'repository','') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
 OR coalesce(p->>'branch','')='' OR coalesce(p->>'headSha','') !~ '^[0-9a-f]{40,64}$'
 OR coalesce(p->>'workerId','')='' THEN RAISE EXCEPTION 'invalid repository head' USING ERRCODE='22023'; END IF;
 INSERT INTO otl.bug_runner_repository_heads(team_id,repository,branch,head_sha,observed_at,worker_id)
 VALUES(p->>'teamId',p->>'repository',p->>'branch',p->>'headSha',coalesce((p->>'observedAt')::timestamptz,clock_timestamp()),p->>'workerId')
 ON CONFLICT(team_id,repository,branch) DO UPDATE SET head_sha=excluded.head_sha,observed_at=excluded.observed_at,worker_id=excluded.worker_id
 WHERE otl.bug_runner_repository_heads.observed_at<=excluded.observed_at RETURNING * INTO h;
 RETURN to_jsonb(h);
END $$;
CREATE OR REPLACE FUNCTION otl.bug_admin_queue(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; transitioned jsonb; base_sha text;
BEGIN
 IF coalesce(p->>'teamId','')='' OR coalesce(p->>'bugId','')='' OR coalesce(p->>'reporterId','')=''
 OR coalesce(p->>'adminId','')='' OR coalesce(p->>'repository','')='' OR coalesce(p->>'branch','')=''
 OR coalesce(p->>'approvalReceipt','') !~ '^[0-9a-f]{64}$' OR coalesce(p->>'idempotencyKey','')=''
 THEN RAISE EXCEPTION 'invalid admin queue request' USING ERRCODE='22023'; END IF;
 SELECT head_sha INTO base_sha FROM otl.bug_runner_repository_heads
 WHERE team_id=p->>'teamId' AND repository=p->>'repository' AND branch=p->>'branch'
 AND observed_at>=clock_timestamp()-interval '5 minutes';
 IF base_sha IS NULL THEN RETURN jsonb_build_object('accepted',false,'reason','runner_head_stale'); END IF;
 SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
 IF NOT FOUND OR r.team_id<>p->>'teamId' OR r.reporter_id<>p->>'reporterId' OR r.packet_revision<>(p->>'packetRevision')::integer
 THEN RAISE EXCEPTION 'admin queue scope mismatch' USING ERRCODE='42501'; END IF;
 IF r.state='queued' THEN RETURN jsonb_build_object('accepted',true,'changed',false,'idempotent',true,'state',r.state,'revision',r.revision,'baseSha',base_sha); END IF;
 IF r.state<>'triaged' THEN RETURN jsonb_build_object('accepted',false,'reason','confirmed_packet_required','state',r.state,'revision',r.revision); END IF;
 transitioned:=otl.bug_transition(jsonb_build_object('bugId',r.bug_id,'toState','queued','actors',jsonb_build_array('admin'),
 'guard',jsonb_build_object('classified',true,'notPaused',true),'evidence',jsonb_build_object('triageReceipt',p->>'approvalReceipt','baseSha',base_sha,'adminId',p->>'adminId'),
 'expectedRevision',r.revision,'idempotencyKey',p->>'idempotencyKey','now',coalesce(p->>'now',clock_timestamp()::text)));
 RETURN transitioned||jsonb_build_object('accepted',true,'baseSha',base_sha);
END $$;
REVOKE ALL ON TABLE otl.bug_runner_repository_heads FROM PUBLIC,otl_bug_runner;
REVOKE ALL ON FUNCTION otl.bug_runner_update_head(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION otl.bug_runner_update_head(jsonb) TO otl_bug_runner;
INSERT INTO otl.schema_migrations(version) VALUES('051-bug-runner-repository-head');
COMMIT;
