BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE otl.bug_reports (
  bug_id text PRIMARY KEY CHECK (bug_id ~ '^BUG-[A-Z0-9]{8,32}$'),
  team_id text NOT NULL CHECK (team_id <> ''),
  state text NOT NULL DEFAULT 'new',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  packet_revision integer NOT NULL DEFAULT 1 CHECK (packet_revision > 0),
  public_alias text NOT NULL UNIQUE CHECK (public_alias ~ '^B-[A-Z0-9]{10,32}$'),
  reporter_id text NOT NULL CHECK (reporter_id <> ''),
  source text NOT NULL CHECK (source IN ('slack','admin','api')),
  source_opaque_ref text NOT NULL CHECK (length(source_opaque_ref) BETWEEN 3 AND 500),
  source_channel_id text,
  source_thread text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  severity text CHECK (severity IS NULL OR severity IN ('low','medium','high','critical')),
  actual text,
  expected text,
  steps jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  location text,
  occurred_at timestamptz,
  frequency text,
  impact text,
  deployed_version text,
  privacy boolean NOT NULL DEFAULT false,
  public_export_enabled boolean NOT NULL DEFAULT true,
  needs_info_started_at timestamptz,
  needs_info_reset_count smallint NOT NULL DEFAULT 0 CHECK (needs_info_reset_count BETWEEN 0 AND 1),
  question_count smallint NOT NULL DEFAULT 0 CHECK (question_count BETWEEN 0 AND 5),
  resume_state text,
  assigned_alias text,
  base_sha text,
  head_sha text,
  confirmed_packet_digest text CHECK (confirmed_packet_digest IS NULL OR confirmed_packet_digest ~ '^[0-9a-f]{64}$'),
  confirmed_evidence_digest text CHECK (confirmed_evidence_digest IS NULL OR confirmed_evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE otl.bug_report_revisions (
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  packet_revision integer NOT NULL CHECK (packet_revision > 0),
  schema_version text NOT NULL CHECK (schema_version IN ('bug_intake.v1','bug_packet.v1')),
  status text NOT NULL CHECK (status IN ('draft','answered','confirmed')),
  sanitized_fields jsonb NOT NULL CHECK (jsonb_typeof(sanitized_fields) = 'object'),
  opaque_ref text NOT NULL CHECK (length(opaque_ref) BETWEEN 8 AND 512),
  object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
  envelope_dek text NOT NULL CHECK (length(envelope_dek) BETWEEN 16 AND 4096),
  kek_version text NOT NULL CHECK (length(kek_version) BETWEEN 1 AND 128),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 12 AND 256),
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  packet_digest text CHECK (packet_digest IS NULL OR packet_digest ~ '^[0-9a-f]{64}$'),
  digest_algorithm text NOT NULL DEFAULT 'sha256' CHECK (digest_algorithm = 'sha256'),
  confirmed_packet jsonb CHECK (confirmed_packet IS NULL OR jsonb_typeof(confirmed_packet) = 'object'),
  reporter_confirmed boolean NOT NULL DEFAULT false,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bug_id, packet_revision),
  CHECK ((status = 'confirmed') = (schema_version = 'bug_packet.v1')),
  CHECK ((status = 'confirmed') = (reporter_confirmed AND confirmed_at IS NOT NULL AND evidence_digest IS NOT NULL AND packet_digest IS NOT NULL AND confirmed_packet IS NOT NULL))
);

CREATE TABLE otl.bug_intake_claims (
  idempotency_key text PRIMARY KEY,
  bug_id text NOT NULL UNIQUE REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE otl.bug_revision_claims (
  bug_id text NOT NULL,
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('answer','confirm')),
  packet_revision integer NOT NULL,
  PRIMARY KEY (bug_id,idempotency_key),
  FOREIGN KEY (bug_id,packet_revision) REFERENCES otl.bug_report_revisions(bug_id,packet_revision) ON DELETE CASCADE
);

CREATE TABLE otl.bug_questions (
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  question_id text NOT NULL,
  field_name text NOT NULL,
  template_version text NOT NULL,
  question_text text NOT NULL CHECK (length(question_text) BETWEEN 1 AND 1000),
  asked_packet_revision integer NOT NULL,
  answer_digest text CHECK (answer_digest IS NULL OR answer_digest ~ '^[0-9a-f]{64}$'),
  answer_opaque_ref text,
  answer_packet_revision integer,
  completeness jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  answered_at timestamptz,
  PRIMARY KEY (bug_id, question_id),
  CHECK ((answer_digest IS NULL) = (answer_packet_revision IS NULL)),
  CHECK ((answer_opaque_ref IS NULL) = (answer_packet_revision IS NULL)),
  CHECK (completeness IS NULL OR jsonb_typeof(completeness) = 'object')
);

CREATE TABLE otl.bug_transition_contract (
  from_state text NOT NULL,
  to_state text NOT NULL,
  variant text NOT NULL DEFAULT '',
  actor_requirements jsonb NOT NULL CHECK (jsonb_typeof(actor_requirements) = 'array'),
  guard_code text NOT NULL,
  required_guard_keys text[] NOT NULL,
  required_evidence_keys text[] NOT NULL,
  side_effect text NOT NULL,
  resume_state text,
  PRIMARY KEY (from_state, to_state, variant)
);

INSERT INTO otl.bug_transition_contract VALUES
('new','triaged','',                 '[ ["deterministic_worker"] ]','packet_complete',ARRAY['formComplete','privacyFalse'],ARRAY['packetDigest'],'triage',NULL),
('new','needs_info','',              '[ ["deterministic_worker"] ]','missing_field',ARRAY['missingRequiredField'],ARRAY['reasonCodes','questionId'],'question',NULL),
('new','duplicate','',               '[ ["admin"] ]','duplicate_confirmed',ARRAY['duplicateConfirmed'],ARRAY['existingBugId','confirmation'],'occurrence',NULL),
('new','private_incident','',         '[ ["deterministic_worker"], ["admin"] ]','private',ARRAY['privacyOrSecurity'],ARRAY['intakeDigest'],'disable_public',NULL),
('needs_info','private_incident','',  '[ ["deterministic_worker"], ["admin"] ]','private',ARRAY['privacyOrSecurity'],ARRAY['intakeDigest'],'disable_public',NULL),
('needs_info','triaged','',           '[ ["reporter","deterministic_worker"] ]','packet_complete',ARRAY['allMissingSupplied'],ARRAY['packetDigest'],'triage',NULL),
('needs_info','needs_info','',        '[ ["reporter","deterministic_worker"] ]','needs_info_loop',ARRAY['stillIncomplete'],ARRAY['answerRevision','completenessResult','questionId'],'question',NULL),
('needs_info','needs_info_exhausted','', '[ ["scheduler"], ["admin"] ]','exhausted',ARRAY['exhausted'],ARRAY['conversationDigest','exhaustionReason'],'admin_handoff',NULL),
('needs_info_exhausted','triaged','', '[ ["admin","deterministic_worker"] ]','packet_complete',ARRAY['packetComplete','reporterSummaryConfirmed'],ARRAY['packetDigest','confirmation'],'triage',NULL),
('needs_info_exhausted','needs_info','', '[ ["admin"] ]','reset_once',ARRAY['newEvidenceRequired'],ARRAY['adminReason','questionId'],'reset_question',NULL),
('needs_info_exhausted','rejected','', '[ ["admin"] ]','rejection',ARRAY['rejectable'],ARRAY['reason'],'notice',NULL),
('new','rejected','',                 '[ ["admin"] ]','rejection',ARRAY['rejectable'],ARRAY['reasonCode'],'notice',NULL),
('needs_info','rejected','',          '[ ["admin"] ]','rejection',ARRAY['rejectable'],ARRAY['reasonCode'],'notice',NULL),
('triaged','queued','',               '[ ["admin"] ]','classified',ARRAY['classified','notPaused'],ARRAY['triageReceipt','baseSha'],'enqueue_reproduce',NULL),
('queued','reproducing','',           '[ ["deterministic_worker"] ]','lease',ARRAY['leaseAcquired','baseShaCurrent'],ARRAY['leaseId','runnerImageDigest'],'heartbeat',NULL),
('queued','blocked_capacity','',       '[ ["deterministic_worker"] ]','capacity',ARRAY['slotUnavailable'],ARRAY['accountAlias','diagnostic'],'release_lease','queued'),
('reproducing','blocked_capacity','',  '[ ["deterministic_worker"] ]','capacity',ARRAY['slotUnavailable'],ARRAY['accountAlias','diagnostic'],'release_lease','queued'),
('reproducing','reproduced','',        '[ ["deterministic_worker"] ]','reproduced',ARRAY['failureObserved'],ARRAY['failingArtifact','commandReceipt'],'enqueue_fix',NULL),
('reproducing','reproduce_failed','',  '[ ["deterministic_worker"] ]','attempts',ARRAY['attemptsExhausted'],ARRAY['attemptReceipts'],'stop',NULL),
('reproducing','needs_info','',        '[ ["admin"] ]','missing_observation',ARRAY['oneMissingObservation'],ARRAY['questionReason','questionId'],'question',NULL),
('reproduce_failed','needs_info','',   '[ ["admin"] ]','missing_observation',ARRAY['oneMissingObservation'],ARRAY['questionReason','questionId'],'question',NULL),
('reproduced','fixing','',             '[ ["deterministic_worker"] ]','fix_lease',ARRAY['fixLease','artifactImmutable'],ARRAY['failingArtifactDigest'],'executor',NULL),
('fixing','reviewing','',              '[ ["deterministic_worker"] ]','checks_green',ARRAY['patchApplies','fixturePasses','fullCheckGreen'],ARRAY['patch','localReceipt'],'enqueue_review',NULL),
('fixing','fix_failed','',             '[ ["deterministic_worker"] ]','fix_failure',ARRAY['fixFailed'],ARRAY['runReceipt'],'stop',NULL),
('fixing','blocked_capacity','',        '[ ["deterministic_worker"] ]','capacity',ARRAY['slotUnavailable'],ARRAY['accountAlias','diagnostic'],'release_lease','fixing'),
('fix_failed','fixing','',             '[ ["admin"], ["signed_retry_policy"] ]','retry',ARRAY['retryBelowTwo','baseShaCurrent'],ARRAY['priorFailure','newLease'],'enqueue_fix',NULL),
('fix_failed','blocked','',            '[ ["admin"] ]','retry_exhausted',ARRAY['retryExhausted'],ARRAY['failureReceipts'],'stop',NULL),
('fix_failed','rejected','',           '[ ["admin"] ]','rejection',ARRAY['invalidOrUnactionable'],ARRAY['rejectionReason'],'notice',NULL),
('reviewing','fixing','',              '[ ["trusted_reviewer"] ]','blocking_finding',ARRAY['blockingFinding'],ARRAY['reviewSchema','headSha'],'enqueue_fix',NULL),
('reviewing','pr_open','',             '[ ["trusted_reviewer","publisher"] ]','publish',ARRAY['noBlockers','diffRevalidated'],ARRAY['trustedReview','publisherReceipt'],'publish_once',NULL),
('reviewing','review_failed','',        '[ ["deterministic_worker"] ]','review_failure',ARRAY['reviewInvalid'],ARRAY['failureReceipt'],'stop',NULL),
('reviewing','blocked_capacity','',     '[ ["deterministic_worker"] ]','capacity_review',ARRAY['slotUnavailable'],ARRAY['accountAlias','diagnostic','resumeState'],'release_lease','reviewing'),
('review_failed','reviewing','',        '[ ["admin"], ["signed_retry_policy"] ]','review_retry',ARRAY['retryBelowTwo','sameHead','sameAlias'],ARRAY['priorFailure','sameAliasLease'],'enqueue_review',NULL),
('review_failed','fixing','',           '[ ["admin"] ]','invalid_patch',ARRAY['invalidPatch'],ARRAY['failureReceipt','reason'],'enqueue_fix',NULL),
('review_failed','rejected','',         '[ ["admin"] ]','rejection',ARRAY['reviewUnavailableAfterRetries'],ARRAY['failureReceipts'],'notice',NULL),
('pr_open','reviewing','',              '[ ["trusted_reviewer"] ]','comment_change',ARRAY['changeRequested','headUnchanged'],ARRAY['commentDigest','currentHead'],'enqueue_review',NULL),
('pr_open','stale_pr','',               '[ ["github_webhook"] ]','stale',ARRAY['signedWebhook','shaChanged'],ARRAY['oldSha','newSha'],'invalidate',NULL),
('stale_pr','fixing','',                '[ ["admin"], ["deterministic_worker"] ]','rebase',ARRAY['baseFetched','bugOpen'],ARRAY['staleReceipt','newBaseSha'],'enqueue_fix',NULL),
('stale_pr','rejected','',              '[ ["admin"] ]','rejection',ARRAY['resolvedOrUnsafe'],ARRAY['reason','linkedChange'],'notice',NULL),
('pr_open','merge_eligible','',          '[ ["deterministic_policy"] ]','merge_policy',ARRAY['attestationsValid'],ARRAY['checkIds','policySha'],'policy_check',NULL),
('merge_eligible','merged','',           '[ ["github_webhook"] ]','merged',ARRAY['signedWebhook','sameHead'],ARRAY['mergeWebhook','mergeSha'],'merge_receipt',NULL),
('merge_eligible','merge_failed','',     '[ ["github_webhook"], ["deterministic_policy"] ]','merge_failure',ARRAY['mergeFailed'],ARRAY['queueReceipt'],'invalidate',NULL),
('merge_failed','reviewing','',          '[ ["admin"], ["signed_policy"] ]','merge_retry',ARRAY['sameHead','transientCleared'],ARRAY['failureReceipt','currentChecks'],'enqueue_review',NULL),
('merge_failed','stale_pr','',           '[ ["github_webhook"] ]','stale',ARRAY['signedWebhook','shaChanged'],ARRAY['signedWebhook'],'invalidate',NULL),
('merge_failed','rejected','',           '[ ["admin"] ]','rejection',ARRAY['notRepairable'],ARRAY['reasonCode'],'notice',NULL),
('merged','staging','',                  '[ ["deployer"] ]','deploy',ARRAY['mergeOnMain'],ARRAY['environmentReceipt'],'deploy',NULL),
('staging','observing','',               '[ ["deploy_observer"] ]','health',ARRAY['healthPass','scenarioPass'],ARRAY['workerVersion','liveArtifacts'],'observe',NULL),
('staging','deploy_failed','',           '[ ["deploy_observer"] ]','deploy_failure',ARRAY['deployFailed'],ARRAY['failureFingerprint'],'rollback',NULL),
('observing','deploy_failed','',         '[ ["deploy_observer"] ]','deploy_failure',ARRAY['deployFailed'],ARRAY['failureFingerprint'],'rollback',NULL),
('deploy_failed','staging','',           '[ ["admin","deployer"] ]','redeploy',ARRAY['rootCauseFixed','sameMergeSha'],ARRAY['failureReceipt','recoveryReceipt'],'deploy',NULL),
('deploy_failed','paused_policy','',     '[ ["signed_safety_policy"] ]','pause',ARRAY['automaticFailure'],ARRAY['failureReceipt'],'pause',NULL),
('deploy_failed','rolled_back','',       '[ ["deployer"] ]','rollback',ARRAY['previousVersionRestored'],ARRAY['rollbackReceipt','healthReceipt'],'rollback',NULL),
('observing','rolled_back','',           '[ ["deployer"] ]','rollback',ARRAY['previousVersionRestored'],ARRAY['rollbackReceipt','healthReceipt'],'rollback',NULL),
('observing','resolved','',              '[ ["deploy_observer"] ]','observed',ARRAY['windowComplete','bugCheckPass'],ARRAY['observationReceipt'],'notice',NULL),
('resolved','reopened','',               '[ ["reporter"], ["admin"], ["observer"] ]','regression',ARRAY['regressionEvidence'],ARRAY['occurrence','deployedSha'],'enqueue_reproduce',NULL),
('rolled_back','reopened','',            '[ ["reporter"], ["admin"], ["observer"] ]','regression',ARRAY['regressionEvidence'],ARRAY['occurrence','deployedSha'],'enqueue_reproduce',NULL),
('blocked_capacity','queued','queued',    '[ ["admin"], ["reset_observer"] ]','capacity_resume',ARRAY['aliasAvailable','baseShaCurrent'],ARRAY['capacityRecovery','originalAlias'],'enqueue_reproduce','queued'),
('blocked_capacity','fixing','fixing',    '[ ["admin"], ["reset_observer"] ]','capacity_resume',ARRAY['aliasAvailable','baseShaCurrent'],ARRAY['capacityRecovery','originalAlias'],'enqueue_fix','fixing'),
('blocked_capacity','reviewing','reviewing','[ ["admin"], ["reset_observer"] ]','capacity_resume',ARRAY['aliasAvailable','headShaCurrent'],ARRAY['capacityRecovery','originalAlias'],'enqueue_review','reviewing'),
('blocked_capacity','paused_policy','',   '[ ["signed_safety_policy"] ]','pause',ARRAY['globalCapacity'],ARRAY['diagnostics'],'pause',NULL),
('blocked','queued','',                   '[ ["admin"] ]','unblocked',ARRAY['blockerResolved','baseShaCurrent'],ARRAY['blockerResolution'],'enqueue_reproduce',NULL),
('blocked','rejected','',                 '[ ["admin"] ]','rejection',ARRAY['blockerPermanent'],ARRAY['reason'],'notice',NULL),
('private_incident','triaged','',         '[ ["admin","security_reviewer"] ]','private_release',ARRAY['distinctApprovals','redactionComplete'],ARRAY['approvalEvents','redactionReceipt','publicSafeDigest'],'triage',NULL),
('private_incident','resolved','',        '[ ["admin","security_reviewer"] ]','private_resolution',ARRAY['incidentHandled'],ARRAY['incidentResolutionReceipt'],'retention',NULL),
('private_incident','rejected','',        '[ ["admin","security_reviewer"] ]','rejection',ARRAY['incidentRejectable'],ARRAY['twoActorReason'],'retention',NULL);

INSERT INTO otl.bug_transition_contract
SELECT source_state,'paused_policy','active_pause','[ ["admin"], ["signed_safety_policy"] ]','pause',ARRAY['globalPauseCas'],ARRAY['reason','triggeringEvidence'],'pause',NULL
FROM unnest(ARRAY['triaged','queued','reproducing','reproduce_failed','reproduced','fixing','fix_failed','reviewing','review_failed','pr_open','stale_pr','merge_eligible','merge_failed','staging','observing']) source_state;

INSERT INTO otl.bug_transition_contract VALUES
('paused_policy','queued','', '[ ["admin","safety_verifier"] ]','recover',ARRAY['pauseCleared','attestationsInvalidated'],ARRAY['recoveryReceipt'],'enqueue_reproduce',NULL);

CREATE TABLE otl.bug_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  variant text NOT NULL DEFAULT '',
  revision integer NOT NULL,
  actors jsonb NOT NULL,
  guard_code text NOT NULL,
  evidence jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (bug_id, idempotency_key)
);

CREATE TABLE otl.bug_artifacts (
  artifact_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  kind text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  opaque_ref text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','private','security')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (bug_id, kind, digest)
);

CREATE TABLE otl.bug_links (
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  linked_bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id),
  relation text NOT NULL CHECK (relation IN ('duplicate','regression_of','caused_by','fixes','occurrence')),
  event_id bigint REFERENCES otl.bug_events(event_id),
  PRIMARY KEY (bug_id, linked_bug_id, relation)
);

CREATE TABLE otl.bug_jobs (
  job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  event_id bigint REFERENCES otl.bug_events(event_id),
  kind text NOT NULL CHECK (kind IN ('reproduce','fix','review','deploy')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','succeeded','failed','cancelled')),
  priority integer NOT NULL DEFAULT 100,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  assigned_alias text,
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, kind),
  CHECK ((status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND worker_id IS NOT NULL))
);

CREATE INDEX bug_jobs_claimable ON otl.bug_jobs(priority, available_at, job_id) WHERE status = 'queued';

CREATE TABLE otl.agent_runs (
  run_id text PRIMARY KEY,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES otl.bug_jobs(job_id),
  account_alias text NOT NULL,
  base_sha text NOT NULL,
  prompt_digest text NOT NULL CHECK (prompt_digest ~ '^[0-9a-f]{64}$'),
  exit_class text,
  token_metadata jsonb NOT NULL DEFAULT '{}',
  elapsed_ms bigint,
  artifact_digest text CHECK (artifact_digest IS NULL OR artifact_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE otl.git_changes (
  change_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bug_id text NOT NULL REFERENCES otl.bug_reports(bug_id) ON DELETE CASCADE,
  branch text,
  commit_sha text,
  pr_number bigint,
  merged_sha text,
  deploy_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION otl.bug_create_draft(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; f jsonb := p->'sanitizedFields'; raw_keys text[] := ARRAY['raw','rawText','rawReport','rawReportText','messageText'];
BEGIN
  IF jsonb_typeof(p) <> 'object' OR jsonb_typeof(f) <> 'object'
     OR coalesce(p->>'idempotencyKey','') = '' OR coalesce(p->>'bugId','') = ''
     OR coalesce(p->>'teamId','') = '' OR coalesce(p->>'reporterId','') = '' OR coalesce(p->>'sourceOpaqueRef','') = '' OR coalesce(p->>'opaqueRef','') = ''
     OR coalesce(p->>'objectDigest','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p->>'envelopeDek','') = '' OR coalesce(p->>'kekVersion','') = '' OR coalesce(p->>'nonce','') = ''
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k = ANY(raw_keys))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(f) k WHERE k = ANY(raw_keys)) THEN
    RAISE EXCEPTION 'invalid bug draft' USING ERRCODE = '22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['title','severity','actual','expected','steps','location','occurredAt','frequency','impact','privacy']))
     OR jsonb_typeof(coalesce(f->'steps','[]'::jsonb))<>'array'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(f->'steps','[]'::jsonb)) step WHERE jsonb_typeof(step)<>'string') THEN
    RAISE EXCEPTION 'unsanitized draft shape' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p->>'idempotencyKey',14));
  SELECT reports.* INTO r FROM otl.bug_intake_claims claims JOIN otl.bug_reports reports USING(bug_id) WHERE claims.idempotency_key=p->>'idempotencyKey';
  IF FOUND THEN RETURN to_jsonb(r); END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id = p->>'bugId';
  IF FOUND THEN RETURN to_jsonb(r); END IF;
  INSERT INTO otl.bug_reports(bug_id,team_id,public_alias,reporter_id,source,source_opaque_ref,source_channel_id,source_thread,title,severity,actual,expected,steps,location,occurred_at,frequency,impact,privacy,public_export_enabled)
  VALUES(p->>'bugId',p->>'teamId',p->>'publicAlias',p->>'reporterId',p->>'source',p->>'sourceOpaqueRef',p->>'sourceChannelId',p->>'sourceThread',f->>'title',f->>'severity',f->>'actual',f->>'expected',coalesce(f->'steps','[]'),f->>'location',nullif(f->>'occurredAt','')::timestamptz,f->>'frequency',f->>'impact',coalesce((f->>'privacy')::boolean,false),NOT coalesce((f->>'privacy')::boolean,false)) RETURNING * INTO r;
  INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce)
  VALUES(r.bug_id,1,'bug_intake.v1','draft',f,p->>'opaqueRef',p->>'objectDigest',p->>'envelopeDek',p->>'kekVersion',p->>'nonce');
  INSERT INTO otl.bug_intake_claims(idempotency_key,bug_id) VALUES(p->>'idempotencyKey',r.bug_id);
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION otl.bug_answer_revision(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; q otl.bug_questions; next_revision integer; claimed_revision integer; claimed_operation text; f jsonb := p->'sanitizedFields'; rev otl.bug_report_revisions;
BEGIN
  IF coalesce(p->>'idempotencyKey','')='' THEN RAISE EXCEPTION 'answer idempotency required' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  SELECT packet_revision,operation INTO claimed_revision,claimed_operation FROM otl.bug_revision_claims WHERE bug_id=p->>'bugId' AND idempotency_key=p->>'idempotencyKey';
  IF FOUND THEN
    IF claimed_operation<>'answer' THEN RAISE EXCEPTION 'idempotency operation mismatch' USING ERRCODE='22023'; END IF;
    RETURN (SELECT to_jsonb(saved) FROM otl.bug_report_revisions saved WHERE saved.bug_id=p->>'bugId' AND saved.packet_revision=claimed_revision);
  END IF;
  IF r.bug_id IS NULL OR r.reporter_id <> p->>'reporterId' OR r.packet_revision <> (p->>'expectedPacketRevision')::integer OR jsonb_typeof(f)<>'object'
     OR NOT (f ?& ARRAY['actual','expected','steps','location','occurredAt','frequency','impact'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['actual','expected','steps','location','occurredAt','frequency','impact']))
     OR jsonb_typeof(f->'steps')<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(f->'steps') step WHERE jsonb_typeof(step)<>'string') THEN
    RAISE EXCEPTION 'answer conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO q FROM otl.bug_questions WHERE bug_id=r.bug_id AND question_id=p->>'questionId' FOR UPDATE;
  IF NOT FOUND OR q.answer_digest IS NOT NULL OR coalesce(p->>'answerDigest','') !~ '^[0-9a-f]{64}$' OR coalesce(p->>'answerOpaqueRef','')='' OR jsonb_typeof(p->'completeness')<>'object' THEN
    RAISE EXCEPTION 'invalid answer' USING ERRCODE='22023';
  END IF;
  next_revision := r.packet_revision + 1;
  INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce)
  SELECT r.bug_id,next_revision,'bug_intake.v1','answered',f,p->>'opaqueRef',p->>'objectDigest',p->>'envelopeDek',p->>'kekVersion',p->>'nonce' RETURNING * INTO rev;
  UPDATE otl.bug_questions SET answer_digest=p->>'answerDigest',answer_opaque_ref=p->>'answerOpaqueRef',answer_packet_revision=next_revision,completeness=p->'completeness',answered_at=clock_timestamp() WHERE bug_id=r.bug_id AND question_id=q.question_id;
  UPDATE otl.bug_reports SET packet_revision=next_revision,actual=f->>'actual',expected=f->>'expected',steps=coalesce(f->'steps','[]'),location=f->>'location',occurred_at=nullif(f->>'occurredAt','')::timestamptz,frequency=f->>'frequency',impact=f->>'impact',updated_at=clock_timestamp() WHERE bug_id=r.bug_id;
  INSERT INTO otl.bug_revision_claims VALUES(r.bug_id,p->>'idempotencyKey','answer',next_revision);
  RETURN to_jsonb(rev);
END $$;

CREATE FUNCTION otl.bug_confirm_packet(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; next_revision integer; claimed_revision integer; claimed_operation text; packet jsonb:=p->'packet'; storage jsonb:=p->'storage'; f jsonb:=packet->'fields'; confirmation jsonb:=packet->'confirmation'; source_metadata jsonb:=packet->'source'; rev otl.bug_report_revisions;
BEGIN
  IF jsonb_typeof(packet)<>'object' OR jsonb_typeof(storage)<>'object' OR coalesce(storage->>'idempotencyKey','')='' THEN RAISE EXCEPTION 'confirmation envelope required' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=packet->>'bugId' FOR UPDATE;
  SELECT packet_revision,operation INTO claimed_revision,claimed_operation FROM otl.bug_revision_claims WHERE bug_id=packet->>'bugId' AND idempotency_key=storage->>'idempotencyKey';
  IF FOUND THEN
    IF claimed_operation<>'confirm' THEN RAISE EXCEPTION 'idempotency operation mismatch' USING ERRCODE='22023'; END IF;
    SELECT * INTO rev FROM otl.bug_report_revisions WHERE bug_id=packet->>'bugId' AND packet_revision=claimed_revision;
    RETURN rev.confirmed_packet;
  END IF;
  IF r.bug_id IS NULL OR r.team_id<>storage->>'teamId' OR r.reporter_id<>storage->>'reporterId' OR r.packet_revision<>(storage->>'expectedPacketRevision')::integer
     OR packet->>'schemaVersion'<>'bug_packet.v1' OR packet->>'status'<>'confirmed' OR coalesce((confirmation->>'reporterConfirmed')::boolean,false) IS NOT TRUE
     OR packet->>'bugId'<>r.bug_id OR source_metadata->>'opaqueRef'<>r.source_opaque_ref
     OR jsonb_typeof(packet->'revision')<>'number' OR (packet->>'revision')::integer<1
     OR coalesce(packet->>'packetDigest','') !~ '^[0-9a-f]{64}$' OR coalesce(packet->>'evidenceDigest','') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(f)<>'object' OR NOT (f ?& ARRAY['actual','expected','steps','location','occurredAt','frequency','impact'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(ARRAY['actual','expected','steps','location','occurredAt','frequency','impact']))
     OR jsonb_typeof(f->'actual')<>'string' OR jsonb_typeof(f->'expected')<>'string' OR jsonb_typeof(f->'location')<>'string' OR jsonb_typeof(f->'occurredAt')<>'string'
     OR f->>'frequency' NOT IN ('always','sometimes','once') OR f->>'impact' NOT IN ('inconvenience','blocked','wrong_data','security_privacy')
     OR jsonb_typeof(f->'steps')<>'array' OR jsonb_array_length(f->'steps') NOT BETWEEN 2 AND 50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(f->'steps') step WHERE jsonb_typeof(step)<>'string')
     OR jsonb_typeof(confirmation)<>'object' OR NOT (confirmation ?& ARRAY['reporterConfirmed','confirmedAt']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(confirmation) k WHERE NOT k=ANY(ARRAY['reporterConfirmed','confirmedAt']))
     OR jsonb_typeof(source_metadata)<>'object' OR NOT (source_metadata ?& ARRAY['kind','opaqueRef']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(source_metadata) k WHERE NOT k=ANY(ARRAY['kind','opaqueRef']))
     OR coalesce(source_metadata->>'kind','')='' OR coalesce(confirmation->>'confirmedAt','')=''
     OR coalesce(storage->>'opaqueRef','')='' OR NOT (packet ?& ARRAY['schemaVersion','bugId','status','revision','fields','confirmation','source','evidenceDigest','packetDigest'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(packet) k WHERE NOT k=ANY(ARRAY['schemaVersion','bugId','status','revision','fields','confirmation','source','evidenceDigest','packetDigest'])) THEN RAISE EXCEPTION 'invalid confirmed packet' USING ERRCODE='22023'; END IF;
  next_revision := r.packet_revision + 1;
  INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce,evidence_digest,packet_digest,reporter_confirmed,confirmed_at,confirmed_packet)
  VALUES(r.bug_id,next_revision,'bug_packet.v1','confirmed',f,storage->>'opaqueRef',storage->>'objectDigest',storage->>'envelopeDek',storage->>'kekVersion',storage->>'nonce',packet->>'evidenceDigest',packet->>'packetDigest',true,(confirmation->>'confirmedAt')::timestamptz,packet) RETURNING * INTO rev;
  UPDATE otl.bug_reports SET packet_revision=next_revision,confirmed_packet_digest=packet->>'packetDigest',confirmed_evidence_digest=packet->>'evidenceDigest',actual=f->>'actual',expected=f->>'expected',steps=f->'steps',location=f->>'location',occurred_at=(f->>'occurredAt')::timestamptz,frequency=f->>'frequency',impact=f->>'impact',updated_at=clock_timestamp() WHERE bug_id=r.bug_id;
  INSERT INTO otl.bug_revision_claims VALUES(r.bug_id,storage->>'idempotencyKey','confirm',next_revision);
  RETURN packet;
END $$;

CREATE FUNCTION otl.bug_transition(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE r otl.bug_reports; c otl.bug_transition_contract; e otl.bug_events; actors jsonb:=p->'actors'; g jsonb:=p->'guard'; evidence jsonb:=p->'evidence'; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); chosen_variant text:=coalesce(p->>'variant',''); k text; requirement jsonb; actors_ok boolean:=false; job_kind text;
BEGIN
  IF jsonb_typeof(p)<>'object' OR jsonb_typeof(actors)<>'array' OR jsonb_array_length(actors)=0 OR jsonb_typeof(g)<>'object' OR jsonb_typeof(evidence)<>'object' OR coalesce(p->>'idempotencyKey','')='' THEN RAISE EXCEPTION 'invalid transition input' USING ERRCODE='22023'; END IF;
  IF actors @> '["llm"]'::jsonb THEN RAISE EXCEPTION 'llm cannot mutate state' USING ERRCODE='42501'; END IF;
  SELECT * INTO e FROM otl.bug_events WHERE bug_id=p->>'bugId' AND idempotency_key=p->>'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('changed',false,'idempotent',true,'eventId',e.event_id,'state',e.to_state,'revision',e.revision); END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown bug' USING ERRCODE='22023'; END IF;
  IF r.revision<>(p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'stale revision' USING ERRCODE='40001'; END IF;
  IF r.state='blocked_capacity' AND chosen_variant='' AND p->>'toState' IN ('queued','fixing','reviewing') THEN chosen_variant:=coalesce(r.resume_state,''); END IF;
  SELECT * INTO c FROM otl.bug_transition_contract WHERE from_state=r.state AND to_state=p->>'toState' AND variant=chosen_variant;
  IF NOT FOUND THEN RAISE EXCEPTION 'transition denied' USING ERRCODE='42501'; END IF;
  FOR requirement IN SELECT value FROM jsonb_array_elements(c.actor_requirements) LOOP
    IF actors @> requirement AND requirement @> actors THEN actors_ok:=true; EXIT; END IF;
  END LOOP;
  IF NOT actors_ok THEN RAISE EXCEPTION 'actor denied' USING ERRCODE='42501'; END IF;
  FOREACH k IN ARRAY c.required_guard_keys LOOP IF NOT (g ? k) OR g->k <> 'true'::jsonb THEN RAISE EXCEPTION 'guard failed: %',k USING ERRCODE='23514'; END IF; END LOOP;
  FOREACH k IN ARRAY c.required_evidence_keys LOOP IF NOT (evidence ? k) OR evidence->k IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb) THEN RAISE EXCEPTION 'evidence missing: %',k USING ERRCODE='23514'; END IF; END LOOP;
  IF c.guard_code='packet_complete' AND r.confirmed_packet_digest IS NULL THEN RAISE EXCEPTION 'confirmed packet required' USING ERRCODE='23514'; END IF;
  IF c.guard_code='needs_info_loop' AND (r.question_count>=5 OR NOT (evidence ? 'questionId') OR EXISTS(SELECT 1 FROM otl.bug_questions WHERE bug_id=r.bug_id AND question_id=evidence->>'questionId')) THEN RAISE EXCEPTION 'needs-info loop exhausted or repeated' USING ERRCODE='23514'; END IF;
  IF c.guard_code='exhausted' AND NOT (r.question_count>=5 OR r.needs_info_started_at + interval '24 hours' <= at_time) THEN RAISE EXCEPTION 'not exhausted' USING ERRCODE='23514'; END IF;
  IF c.guard_code='reset_once' AND r.needs_info_reset_count<>0 THEN RAISE EXCEPTION 'needs-info reset exhausted' USING ERRCODE='23514'; END IF;
  IF c.guard_code LIKE 'capacity_resume%' OR c.guard_code='capacity_resume' THEN
    IF r.resume_state<>c.resume_state OR r.assigned_alias IS DISTINCT FROM evidence->>'originalAlias' THEN RAISE EXCEPTION 'capacity resume mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  INSERT INTO otl.bug_events(bug_id,idempotency_key,from_state,to_state,variant,revision,actors,guard_code,evidence,occurred_at)
  VALUES(r.bug_id,p->>'idempotencyKey',r.state,c.to_state,c.variant,r.revision+1,actors,c.guard_code,evidence,at_time) RETURNING * INTO e;
  UPDATE otl.bug_reports SET state=c.to_state,revision=revision+1,updated_at=at_time,
    needs_info_started_at=CASE WHEN c.to_state='needs_info' AND c.guard_code='missing_field' THEN at_time WHEN c.guard_code='reset_once' THEN at_time ELSE needs_info_started_at END,
    needs_info_reset_count=needs_info_reset_count+CASE WHEN c.guard_code='reset_once' THEN 1 ELSE 0 END,
    resume_state=CASE WHEN c.to_state='blocked_capacity' THEN c.resume_state WHEN r.state='blocked_capacity' THEN NULL ELSE resume_state END,
    assigned_alias=CASE WHEN c.to_state='blocked_capacity' THEN evidence->>'accountAlias' ELSE assigned_alias END,
    public_export_enabled=CASE WHEN c.to_state='private_incident' THEN false ELSE public_export_enabled END,
    question_count=question_count+CASE WHEN c.side_effect IN ('question','reset_question') THEN 1 ELSE 0 END
  WHERE bug_id=r.bug_id;
  IF c.side_effect IN ('question','reset_question') THEN
    INSERT INTO otl.bug_questions(bug_id,question_id,field_name,template_version,question_text,asked_packet_revision)
    VALUES(r.bug_id,evidence->>'questionId',coalesce(evidence->>'fieldName','unspecified'),coalesce(evidence->>'templateVersion','v1'),coalesce(evidence->>'questionText','sanitized follow-up'),r.packet_revision);
  END IF;
  job_kind:=CASE c.side_effect WHEN 'enqueue_reproduce' THEN 'reproduce' WHEN 'enqueue_fix' THEN 'fix' WHEN 'enqueue_review' THEN 'review' WHEN 'deploy' THEN 'deploy' ELSE NULL END;
  IF job_kind IS NOT NULL THEN
    INSERT INTO otl.bug_jobs(bug_id,event_id,kind,payload,payload_digest,assigned_alias)
    VALUES(r.bug_id,e.event_id,job_kind,jsonb_build_object('state',c.to_state),coalesce(evidence->>'payloadDigest',repeat('0',64)),coalesce(evidence->>'originalAlias',r.assigned_alias)) ON CONFLICT(event_id,kind) DO NOTHING;
  END IF;
  IF c.side_effect='release_lease' THEN UPDATE otl.bug_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,cancel_reason='blocked_capacity',updated_at=at_time WHERE bug_id=r.bug_id AND status='leased'; END IF;
  RETURN jsonb_build_object('changed',true,'idempotent',false,'eventId',e.event_id,'state',c.to_state,'revision',e.revision);
END $$;

CREATE FUNCTION otl.bug_enqueue_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs;
BEGIN
  IF coalesce(p->>'payloadDigest','') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p->'payload')<>'object' THEN RAISE EXCEPTION 'invalid job' USING ERRCODE='22023'; END IF;
  INSERT INTO otl.bug_jobs(bug_id,kind,payload,payload_digest,assigned_alias,available_at)
  VALUES(p->>'bugId',p->>'kind',p->'payload',p->>'payloadDigest',p->>'assignedAlias',coalesce((p->>'availableAt')::timestamptz,clock_timestamp())) RETURNING * INTO j;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_lease_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
BEGIN
  IF coalesce(p->>'workerId','')='' OR coalesce(p->>'accountAlias','')='' OR coalesce(p->>'leaseToken','')='' OR lease_seconds NOT BETWEEN 30 AND 1800 OR jsonb_typeof(p->'kinds')<>'array' THEN RAISE EXCEPTION 'invalid lease' USING ERRCODE='22023'; END IF;
  SELECT * INTO j FROM otl.bug_jobs WHERE status='leased' AND worker_id=p->>'workerId' AND lease_token=p->>'leaseToken';
  IF FOUND THEN RETURN to_jsonb(j); END IF;
  UPDATE otl.bug_jobs SET status=CASE WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,finished_at=CASE WHEN attempt>=3 THEN at_time END,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=at_time WHERE status='leased' AND lease_expires_at<at_time;
  SELECT * INTO j FROM otl.bug_jobs WHERE status='queued' AND available_at<=at_time AND kind IN (SELECT jsonb_array_elements_text(p->'kinds')) AND (assigned_alias IS NULL OR assigned_alias=p->>'accountAlias') ORDER BY priority,available_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  UPDATE otl.bug_jobs SET status='leased',worker_id=p->>'workerId',assigned_alias=p->>'accountAlias',lease_token=p->>'leaseToken',lease_expires_at=at_time+make_interval(secs=>lease_seconds),heartbeat_at=at_time,attempt=attempt+1,updated_at=at_time WHERE job_id=j.job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_heartbeat_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp()); lease_seconds integer:=coalesce((p->>'leaseSeconds')::integer,300);
BEGIN
  UPDATE otl.bug_jobs SET heartbeat_at=at_time,lease_expires_at=at_time+make_interval(secs=>lease_seconds),updated_at=at_time WHERE job_id=(p->>'jobId')::bigint AND status='leased' AND lease_token=p->>'leaseToken' AND worker_id=p->>'workerId' AND lease_expires_at>=at_time RETURNING * INTO j;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease lost' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_finish_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  SELECT * INTO j FROM otl.bug_jobs WHERE job_id=(p->>'jobId')::bigint FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown job' USING ERRCODE='22023'; END IF;
  IF j.status IN ('succeeded','failed') AND j.result_digest=p->>'resultDigest' THEN RETURN to_jsonb(j); END IF;
  IF j.status<>'leased' OR j.lease_token<>p->>'leaseToken' OR coalesce(p->>'resultDigest','') !~ '^[0-9a-f]{64}$' OR p->>'status' NOT IN ('succeeded','failed') THEN RAISE EXCEPTION 'finish conflict' USING ERRCODE='40001'; END IF;
  UPDATE otl.bug_jobs SET status=p->>'status',result_digest=p->>'resultDigest',finished_at=at_time,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=at_time WHERE job_id=j.job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_cancel_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE j otl.bug_jobs; at_time timestamptz:=coalesce((p->>'now')::timestamptz,clock_timestamp());
BEGIN
  SELECT * INTO j FROM otl.bug_jobs WHERE job_id=(p->>'jobId')::bigint FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown job' USING ERRCODE='22023'; END IF;
  IF j.status='cancelled' AND j.cancel_reason=p->>'reason' THEN RETURN to_jsonb(j); END IF;
  IF j.status NOT IN ('queued','leased') OR coalesce(p->>'actor','') NOT IN ('admin','signed_safety_policy') THEN RAISE EXCEPTION 'cancel denied' USING ERRCODE='42501'; END IF;
  UPDATE otl.bug_jobs SET status='cancelled',cancel_reason=p->>'reason',finished_at=at_time,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=at_time WHERE job_id=j.job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END $$;

CREATE FUNCTION otl.bug_read_owned(p_team_id text,p_bug_id text,p_reporter_id text,p_expected_revision integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; rev otl.bug_report_revisions; questions jsonb;
BEGIN
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p_bug_id;
  IF NOT FOUND OR r.team_id<>p_team_id OR r.reporter_id<>p_reporter_id THEN RAISE EXCEPTION 'bug read denied' USING ERRCODE='42501'; END IF;
  IF p_expected_revision IS NOT NULL AND r.revision<>p_expected_revision THEN RAISE EXCEPTION 'stale bug read' USING ERRCODE='40001'; END IF;
  SELECT * INTO rev FROM otl.bug_report_revisions WHERE bug_id=r.bug_id AND packet_revision=r.packet_revision;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'questionId',q.question_id,'fieldName',q.field_name,'templateVersion',q.template_version,
    'questionText',q.question_text,'askedPacketRevision',q.asked_packet_revision,'askedAt',q.created_at,
    'answered',q.answer_digest IS NOT NULL,'answerDigest',q.answer_digest,
    'answerOpaqueRef',q.answer_opaque_ref,'answerPacketRevision',q.answer_packet_revision,
    'completeness',q.completeness
  ) ORDER BY q.created_at,q.question_id),'[]'::jsonb) INTO questions FROM otl.bug_questions q WHERE q.bug_id=r.bug_id;
  RETURN jsonb_build_object(
    'bugId',r.bug_id,'teamId',r.team_id,'state',r.state,'revision',r.revision,'packetRevision',r.packet_revision,
    'needsInfoStartedAt',r.needs_info_started_at,
    'reporterId',r.reporter_id,'sanitizedFields',rev.sanitized_fields,
    'source',jsonb_strip_nulls(jsonb_build_object('kind',r.source,'opaqueRef',r.source_opaque_ref,'channelId',r.source_channel_id,'thread',r.source_thread)),
    'currentRevision',jsonb_build_object(
      'packetRevision',rev.packet_revision,'schemaVersion',rev.schema_version,'status',rev.status,
      'latestOpaqueRef',rev.opaque_ref,'objectDigest',rev.object_digest,'kekVersion',rev.kek_version,'nonce',rev.nonce,
      'evidenceDigest',rev.evidence_digest,'packetDigest',rev.packet_digest,'confirmedPacket',rev.confirmed_packet
    ),
    'questions',questions
  );
END $$;

CREATE FUNCTION otl.bug_get_draft(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,otl AS $$
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'bugId','')='' OR coalesce(p->>'reporterId','')='' THEN RAISE EXCEPTION 'invalid bug read' USING ERRCODE='22023'; END IF;
  RETURN otl.bug_read_owned(p->>'teamId',p->>'bugId',p->>'reporterId',CASE WHEN p ? 'expectedRevision' THEN (p->>'expectedRevision')::integer END);
END $$;

CREATE FUNCTION otl.bug_find_active_draft(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,otl AS $$
DECLARE id text;
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'reporterId','')=''
     OR (coalesce(p->>'sourceOpaqueRef','')='' AND (coalesce(p->>'sourceChannelId','')='' OR coalesce(p->>'sourceThread','')='')) THEN RAISE EXCEPTION 'invalid active draft lookup' USING ERRCODE='22023'; END IF;
  SELECT bug_id INTO id FROM otl.bug_reports
  WHERE team_id=p->>'teamId' AND reporter_id=p->>'reporterId'
    AND ((coalesce(p->>'sourceOpaqueRef','')<>'' AND source_opaque_ref=p->>'sourceOpaqueRef')
      OR (coalesce(p->>'sourceOpaqueRef','')='' AND source_channel_id=p->>'sourceChannelId' AND source_thread=p->>'sourceThread'))
    AND state IN ('new','needs_info','needs_info_exhausted')
  ORDER BY created_at DESC,bug_id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  RETURN otl.bug_read_owned(p->>'teamId',id,p->>'reporterId',NULL);
END $$;

CREATE INDEX bug_reports_active_draft ON otl.bug_reports(team_id,reporter_id,source_opaque_ref,created_at DESC) WHERE state IN ('new','needs_info','needs_info_exhausted');

REVOKE ALL ON otl.bug_transition_contract FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.bug_read_owned(text,text,text,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION otl.bug_create_draft(jsonb),otl.bug_answer_revision(jsonb),otl.bug_confirm_packet(jsonb),otl.bug_transition(jsonb),otl.bug_enqueue_job(jsonb),otl.bug_lease_job(jsonb),otl.bug_heartbeat_job(jsonb),otl.bug_finish_job(jsonb),otl.bug_cancel_job(jsonb),otl.bug_get_draft(jsonb),otl.bug_find_active_draft(jsonb) FROM PUBLIC;

INSERT INTO otl.schema_migrations(version) VALUES('014-bug-ledger');
COMMIT;
