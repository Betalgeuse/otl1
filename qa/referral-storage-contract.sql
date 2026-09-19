\set ON_ERROR_STOP on
CREATE TEMP TABLE referral_check_count(value integer NOT NULL);
INSERT INTO referral_check_count VALUES(0);
CREATE FUNCTION pg_temp.assert_referral(condition boolean,message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION '%',message; END IF;
  UPDATE referral_check_count SET value=value+1;
END $$;

INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TREF','UADMIN');
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('resolve',jsonb_build_object('teamId','TREF','tokenDigest',repeat('0',64)))=
  '{"available": false}'::jsonb,'unknown token leaked detail');

DO $$ BEGIN
  BEGIN
    PERFORM otl.referral_runtime_execute('issue',jsonb_build_object(
      'teamId','TREF','userId','UBOT','linkId','LNK-BOT1','tokenDigest',repeat('9',64),'now','2026-09-19T00:00:00Z'));
    RAISE EXCEPTION 'bot referral accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='bot referral accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral member unavailable','wrong bot denial');
  END;
  BEGIN
    PERFORM otl.referral_runtime_execute('issue',jsonb_build_object(
      'teamId','TREF','userId','UDELETED','linkId','LNK-DELETED1','tokenDigest',repeat('8',64),'now','2026-09-19T00:00:00Z'));
    RAISE EXCEPTION 'deleted referral accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='deleted referral accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral member unavailable','wrong deleted denial');
  END;
  BEGIN
    PERFORM otl.referral_runtime_execute('issue',jsonb_build_object(
      'teamId','TOTHER','userId','UREFERRER','linkId','LNK-CROSS1','tokenDigest',repeat('7',64),'now','2026-09-19T00:00:00Z'));
    RAISE EXCEPTION 'cross-team referral accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='cross-team referral accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral member unavailable','wrong cross-team denial');
  END;
END $$;

SELECT otl.referral_runtime_execute('issue',jsonb_build_object(
  'teamId','TREF','userId','UREFERRER','linkId','LNK-REF0001','tokenDigest',repeat('1',64),'now','2026-09-19T00:00:00Z'));
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('issue',jsonb_build_object(
    'teamId','TREF','userId','UREFERRER','linkId','LNK-IGNORED','tokenDigest',repeat('3',64),'now','2026-09-19T00:00:01Z'))->>'linkId'='LNK-REF0001',
  'stable issue replaced link');
SELECT otl.referral_runtime_execute('set_status',jsonb_build_object(
  'teamId','TREF','userId','UREFERRER','status','paused','now','2026-09-19T00:00:02Z'));
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('issue',jsonb_build_object(
    'teamId','TREF','userId','UREFERRER','linkId','LNK-IGNORED','tokenDigest',repeat('3',64),'now','2026-09-19T00:00:03Z'))->>'linkId'='LNK-REF0001',
  'paused link was not restored');
SELECT otl.referral_runtime_execute('rotate',jsonb_build_object(
  'teamId','TREF','userId','UREFERRER','linkId','LNK-REF0002','tokenDigest',repeat('2',64),'now','2026-09-19T00:00:04Z'));
SELECT otl.referral_runtime_execute('issue',jsonb_build_object(
  'teamId','TREF','userId','UADMIN','linkId','LNK-ADMIN01','tokenDigest',repeat('a',64),'now','2026-09-19T00:00:05Z'));
UPDATE otl.member_lifecycles SET state='dormant',last_transition_at='2026-09-19T00:00:06Z'
  WHERE team_id='TREF' AND user_id='UADMIN';
SELECT otl.referral_runtime_execute('set_status',jsonb_build_object(
  'teamId','TREF','userId','UADMIN','status','paused','now','2026-09-19T00:00:06Z'));
UPDATE otl.member_lifecycles SET state='active',last_transition_at='2026-09-19T00:00:07Z'
  WHERE team_id='TREF' AND user_id='UADMIN';
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('issue',jsonb_build_object(
    'teamId','TREF','userId','UADMIN','linkId','LNK-IGNORED2','tokenDigest',repeat('b',64),'now','2026-09-19T00:00:07Z'))->>'linkId'='LNK-ADMIN01',
  'lifecycle pause did not restore stable link');
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('resolve',jsonb_build_object('teamId','TREF','tokenDigest',repeat('1',64)))=
  otl.referral_runtime_execute('resolve',jsonb_build_object('teamId','TREF','tokenDigest',repeat('0',64))),
  'revoked token leaked distinct result');
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('resolve',jsonb_build_object('teamId','TREF','tokenDigest',repeat('2',64)))=
  '{"available": true}'::jsonb,'active token did not resolve');
SELECT pg_temp.assert_referral(
  (SELECT count(*) FROM otl.member_referral_links WHERE team_id='TREF' AND referrer_user_id='UREFERRER')=2,
  'rotation lineage count mismatch');
SELECT pg_temp.assert_referral(
  (SELECT count(*) FROM otl.member_referral_links WHERE team_id='TREF' AND referrer_user_id='UREFERRER' AND status='active')=1,
  'rotation left multiple active links');

CREATE FUNCTION pg_temp.submit_request(
  request_id text,receipt_id text,token text,email_hash text,withdrawal text,event_key text,now_at timestamptz
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT otl.referral_runtime_execute('submit',jsonb_build_object(
    'teamId','TREF','tokenDigest',token,'emailDigest',email_hash,'requestId',request_id,
    'receiptId',receipt_id,'withdrawalDigest',withdrawal,'consentVersion','invite-consent-v1',
    'consentedAt',now_at,'key',event_key,'opaqueRef','invite-private/'||request_id||'/0.enc',
    'objectDigest',repeat(substr(email_hash,1,1),64),'envelopeDek','opaque.envelope','nonce','opaque-nonce',
    'keyVersion','invite-kek-2026-01','now',now_at))
$$;

SELECT pg_temp.submit_request('REQ-HAPPY0001','RCP-HAPPY0001',repeat('2',64),repeat('4',64),repeat('5',64),'submit-happy','2026-09-19T01:00:00Z');
SELECT pg_temp.assert_referral(
  pg_temp.submit_request('REQ-DUPLICATE1','RCP-DUPLICATE1',repeat('a',64),repeat('4',64),repeat('6',64),'submit-duplicate','2026-09-19T01:00:01Z')->>'receiptId'='RCP-HAPPY0001',
  'duplicate did not return earliest receipt');
SELECT pg_temp.assert_referral(
  (SELECT referrer_user_id FROM otl.referral_requests WHERE request_id='REQ-HAPPY0001')='UREFERRER',
  'duplicate changed earliest referrer');
SELECT pg_temp.assert_referral(
  pg_temp.submit_request('REQ-HAPPY0001','RCP-HAPPY0001',repeat('2',64),repeat('4',64),repeat('5',64),'submit-happy','2026-09-19T01:00:00Z')->>'receiptId'='RCP-HAPPY0001',
  'exact submission replay changed receipt');

DO $$ BEGIN
  BEGIN
    PERFORM otl.referral_runtime_execute('submit',jsonb_build_object(
      'teamId','TREF','tokenDigest',repeat('2',64),'emailDigest',repeat('6',64),
      'requestId','REQ-NOCONSENT','receiptId','RCP-NOCONSENT','withdrawalDigest',repeat('7',64),
      'consentVersion','wrong','consentedAt','2026-09-19T01:00:00Z','key','no-consent',
      'opaqueRef','invite-private/REQ-NOCONSENT/0.enc','objectDigest',repeat('d',64),
      'envelopeDek','opaque','nonce','nonce','keyVersion','invite-kek-2026-01','now','2026-09-19T01:00:00Z'));
    RAISE EXCEPTION 'missing consent accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='missing consent accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='invalid referral request','wrong consent denial');
  END;
  BEGIN
    PERFORM pg_temp.submit_request('REQ-COLLISION1','RCP-COLLISION1',repeat('2',64),repeat('7',64),repeat('8',64),'submit-happy','2026-09-19T01:00:00Z');
    RAISE EXCEPTION 'idempotency collision accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='idempotency collision accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral idempotency collision','wrong collision denial');
  END;
  BEGIN
    PERFORM pg_temp.submit_request('REQ-UNICODE01','RCP-UNICODE01',repeat('2',64),'ＥＭＡＩＬ',repeat('8',64),'unicode','2026-09-19T01:00:00Z');
    RAISE EXCEPTION 'malformed digest accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='malformed digest accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='invalid referral request','wrong malformed denial');
  END;
END $$;

SELECT pg_temp.assert_referral(
  (SELECT count(*) FROM otl.referral_requests WHERE email_digest=repeat('4',64) AND state='pending')=1,
  'open email uniqueness failed');
SELECT pg_temp.assert_referral(
  (SELECT count(*) FROM otl.referral_outbox WHERE request_id='REQ-HAPPY0001' AND effect_type='admin_review')=1,
  'submission outbox duplicated');
SELECT pg_temp.assert_referral(
  (SELECT consent_version||':'||(consented_at='2026-09-19T01:00:00Z') FROM otl.referral_consents
    WHERE request_id='REQ-HAPPY0001')='invite-consent-v1:true',
  'consent ledger mismatch');

DO $$ BEGIN
  BEGIN
    PERFORM otl.referral_admin_execute('decide',jsonb_build_object(
      'teamId','TREF','adminId','UREFERRER','requestId','REQ-HAPPY0001','decision','approved',
      'expectedRevision',0,'key','approve','now','2026-09-19T02:00:00Z'));
    RAISE EXCEPTION 'forged admin accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='forged admin accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral admin denied','wrong admin denial');
  END;
  BEGIN
    UPDATE otl.referral_consents SET consented_at=consented_at+interval '1 second'
      WHERE request_id='REQ-HAPPY0001';
    RAISE EXCEPTION 'consent mutation accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='consent mutation accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral audit rows are immutable','wrong consent immutable denial');
  END;
  BEGIN
    UPDATE otl.referral_requests SET referrer_user_id='UADMIN' WHERE request_id='REQ-HAPPY0001';
    RAISE EXCEPTION 'referrer mutation accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='referrer mutation accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral identity is immutable','wrong referrer immutable denial');
  END;
END $$;
SELECT otl.referral_admin_execute('decide',jsonb_build_object(
  'teamId','TREF','adminId','UADMIN','requestId','REQ-HAPPY0001','decision','approved',
  'expectedRevision',0,'key','approve','now','2026-09-19T02:00:00Z'));
SELECT pg_temp.assert_referral(
  otl.referral_admin_execute('decide',jsonb_build_object(
    'teamId','TREF','adminId','UADMIN','requestId','REQ-HAPPY0001','decision','approved',
    'expectedRevision',0,'key','approve','now','2026-09-19T02:00:00Z'))->>'state'='approved',
  'decision replay failed');
DO $$ BEGIN
  BEGIN
    PERFORM otl.referral_admin_execute('mark_invited',jsonb_build_object(
      'teamId','TREF','adminId','UADMIN','requestId','REQ-HAPPY0001','expectedRevision',0,
      'key','manual-invite','now','2026-09-19T02:01:00Z'));
    RAISE EXCEPTION 'stale revision accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='stale revision accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='stale referral revision','wrong stale denial');
  END;
END $$;
SELECT otl.referral_admin_execute('mark_invited',jsonb_build_object(
  'teamId','TREF','adminId','UADMIN','requestId','REQ-HAPPY0001','expectedRevision',1,
  'key','manual-invite','now','2026-09-19T02:01:00Z'));
SELECT pg_temp.assert_referral(
  (SELECT state FROM otl.referral_requests WHERE request_id='REQ-HAPPY0001')='approved',
  'manual assertion falsely changed delivery state');
SELECT pg_temp.assert_referral(
  (SELECT count(*) FROM otl.referral_manual_invite_assertions WHERE request_id='REQ-HAPPY0001')=1,
  'manual assertion missing');
SELECT otl.referral_runtime_execute('attribute_join',jsonb_build_object(
  'teamId','TREF','userId','UJOINED','emailDigest',repeat('4',64),'eventId','EvJoin01','now','2026-09-20T01:00:00Z'));
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('attribute_join',jsonb_build_object(
    'teamId','TREF','userId','UJOINED','emailDigest',repeat('4',64),'eventId','EvJoin01','now','2026-09-20T01:00:01Z'))->>'state'='joined',
  'join replay was not idempotent');
SELECT pg_temp.assert_referral(
  (SELECT referrer_user_id FROM otl.member_referral_attributions WHERE introduced_user_id='UJOINED')='UREFERRER',
  'join attribution lost original referrer');
SELECT pg_temp.assert_referral(
  (SELECT payload_purge_after FROM otl.referral_requests WHERE request_id='REQ-HAPPY0001')='2026-09-27T01:00:00Z',
  'joined retention is not seven days');
SELECT pg_temp.assert_referral(
  pg_temp.submit_request('REQ-DUPLICATE1','RCP-DUPLICATE1',repeat('a',64),repeat('4',64),repeat('6',64),'submit-duplicate','2026-09-19T01:00:01Z')->>'receiptId'='RCP-HAPPY0001' AND
  (SELECT count(*) FROM otl.referral_requests WHERE email_digest=repeat('4',64))=1,
  'duplicate idempotency key created a request after terminal state');

SELECT pg_temp.submit_request('REQ-WITHDRAW01','RCP-WITHDRAW01',repeat('a',64),repeat('4',64),repeat('6',64),'submit-withdraw','2026-09-20T02:00:00Z');
SELECT otl.referral_runtime_execute('withdraw',jsonb_build_object(
  'teamId','TREF','receiptId','RCP-WITHDRAW01','withdrawalDigest',repeat('6',64),
  'key','withdraw','now','2026-09-20T02:01:00Z'));
SELECT pg_temp.assert_referral(
  (SELECT state||':'||(payload_purge_after='2026-09-21T02:01:00Z') FROM otl.referral_requests WHERE request_id='REQ-WITHDRAW01')='withdrawn:true',
  'withdrawal retention is not 24 hours');

SELECT pg_temp.submit_request('REQ-DECLINE001','RCP-DECLINE001',repeat('2',64),repeat('6',64),repeat('7',64),'submit-decline','2026-09-20T03:00:00Z');
SELECT otl.referral_admin_execute('decide',jsonb_build_object(
  'teamId','TREF','adminId','UADMIN','requestId','REQ-DECLINE001','decision','declined',
  'expectedRevision',0,'key','decline','now','2026-09-20T03:01:00Z'));
SELECT pg_temp.assert_referral(
  pg_temp.submit_request('REQ-AFTERDECL','RCP-AFTERDECL',repeat('a',64),repeat('6',64),repeat('8',64),'after-decline','2026-09-20T03:02:00Z')->>'receiptId'='RCP-AFTERDECL',
  'terminal decline blocked new referrer');
SELECT otl.referral_admin_execute('decide',jsonb_build_object(
  'teamId','TREF','adminId','UADMIN','requestId','REQ-AFTERDECL','decision','duplicate',
  'expectedRevision',0,'key','duplicate','now','2026-09-20T03:03:00Z'));

SELECT pg_temp.submit_request('REQ-ABUSE00001','RCP-ABUSE00001',repeat('2',64),repeat('7',64),repeat('8',64),'submit-abuse','2026-09-20T04:00:00Z');
SELECT otl.referral_admin_execute('decide',jsonb_build_object(
  'teamId','TREF','adminId','UADMIN','requestId','REQ-ABUSE00001','decision','suspected_abuse',
  'expectedRevision',0,'key','abuse','now','2026-09-20T04:01:00Z'));
SELECT pg_temp.assert_referral(
  (SELECT count(DISTINCT decision_code) FROM otl.referral_decisions)=5,
  'finite decision codes were not all represented');

SELECT pg_temp.submit_request('REQ-EXPIRE0001','RCP-EXPIRE0001',repeat('2',64),repeat('8',64),repeat('9',64),'submit-expire','2026-09-20T05:00:00Z');
SELECT otl.referral_admin_execute('expire',jsonb_build_object(
  'teamId','TREF','adminId','UADMIN','requestId','REQ-EXPIRE0001','expectedRevision',0,
  'key','expire','now','2026-10-21T05:00:00Z'));
SELECT pg_temp.assert_referral(
  (SELECT state FROM otl.referral_requests WHERE request_id='REQ-EXPIRE0001')='expired',
  'due request did not expire');

CREATE TEMP TABLE purge_receipt(value jsonb NOT NULL);
INSERT INTO purge_receipt SELECT otl.referral_runtime_execute('claim_purge',jsonb_build_object(
  'teamId','TREF','key','purge-first','now','2026-09-21T02:01:01Z'));
SELECT pg_temp.assert_referral(
  (SELECT value->>'requestId' FROM purge_receipt)='REQ-WITHDRAW01',
  'withdrawn payload was not due after 24 hours');
SELECT otl.referral_runtime_execute('finish_purge',jsonb_build_object(
  'teamId','TREF','requestId','REQ-WITHDRAW01','key','purge-first','status','failed','now','2026-09-21T02:01:02Z'));
SELECT pg_temp.assert_referral(
  (SELECT purge_status||':'||purge_attempts FROM otl.referral_private_payloads WHERE request_id='REQ-WITHDRAW01')='failed:1',
  'purge failure was not retryable');
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('claim_purge',jsonb_build_object(
    'teamId','TREF','key','purge-too-early','now','2026-09-21T02:15:00Z'))='null'::jsonb,
  'purge retried before retry deadline');
TRUNCATE purge_receipt;
INSERT INTO purge_receipt SELECT otl.referral_runtime_execute('claim_purge',jsonb_build_object(
  'teamId','TREF','key','purge-retry','now','2026-09-21T02:17:00Z'));
SELECT otl.referral_runtime_execute('finish_purge',jsonb_build_object(
  'teamId','TREF','requestId','REQ-WITHDRAW01','key','purge-retry','status','purged','now','2026-09-21T02:17:01Z'));
SELECT pg_temp.assert_referral(
  otl.referral_runtime_execute('finish_purge',jsonb_build_object(
    'teamId','TREF','requestId','REQ-WITHDRAW01','key','purge-retry','status','purged','now','2026-09-21T02:17:02Z'))->>'status'='purged',
  'purge completion replay was not idempotent');
SELECT pg_temp.assert_referral(
  (SELECT purge_status='purged' AND envelope_dek IS NULL AND nonce IS NULL
    AND opaque_ref<>'' AND object_digest=repeat('4',64) AND key_version='invite-kek-2026-01'
    FROM otl.referral_private_payloads WHERE request_id='REQ-WITHDRAW01'),
  'purge did not retain only opaque integrity metadata');

DO $$ DECLARE claimed jsonb; BEGIN
  LOOP
    claimed:=otl.referral_runtime_execute('claim_purge',jsonb_build_object(
      'teamId','TREF','key','purge-all-'||clock_timestamp(),'now','2026-10-22T00:00:00Z'));
    EXIT WHEN claimed='null'::jsonb;
    PERFORM otl.referral_runtime_execute('finish_purge',jsonb_build_object(
      'teamId','TREF','requestId',claimed->>'requestId','key',claimed->>'claimKey',
      'status','purged','now','2026-10-22T00:00:01Z'));
  END LOOP;
END $$;
SELECT pg_temp.assert_referral(
  NOT EXISTS(SELECT 1 FROM otl.referral_private_payloads WHERE purge_status<>'purged'),
  'due private payload survived purge');
SELECT pg_temp.assert_referral(
  EXISTS(SELECT 1 FROM otl.member_referral_attributions WHERE request_id='REQ-HAPPY0001') AND
  EXISTS(SELECT 1 FROM otl.referral_request_events WHERE request_id='REQ-HAPPY0001' AND event_type='joined'),
  'payload purge removed attribution or audit');

DO $$ BEGIN
  BEGIN
    UPDATE otl.referral_request_events SET result='{}' WHERE request_id='REQ-HAPPY0001';
    RAISE EXCEPTION 'audit mutation accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='audit mutation accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral audit rows are immutable','wrong immutable denial');
  END;
END $$;

DO $$ DECLARE before_requests bigint; before_events bigint; BEGIN
  SELECT count(*) INTO before_requests FROM otl.referral_requests;
  SELECT count(*) INTO before_events FROM otl.referral_request_events;
  BEGIN
    PERFORM pg_temp.submit_request('REQ-ROLLBACK01','RCP-ROLLBACK01',repeat('2',64),repeat('9',64),repeat('a',64),'rollback','2026-09-20T06:00:00Z');
    RAISE EXCEPTION 'force rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'force rollback' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.assert_referral((SELECT count(*) FROM otl.referral_requests)=before_requests,'request rollback leaked');
  PERFORM pg_temp.assert_referral((SELECT count(*) FROM otl.referral_request_events)=before_events,'event rollback leaked');
END $$;

DO $$ BEGIN
  BEGIN
    PERFORM otl.referral_admin_execute('decide',jsonb_build_object(
      'teamId','TREF','adminId','UADMIN','requestId','REQ-EXPIRE0001','decision','declined',
      'key','missing-revision','now','2026-10-21T05:00:01Z'));
    RAISE EXCEPTION 'missing revision accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='missing revision accepted' THEN RAISE; END IF;
    PERFORM pg_temp.assert_referral(SQLERRM='referral revision required','wrong missing revision denial');
  END;
END $$;

SELECT pg_temp.assert_referral(
  NOT has_function_privilege('public','otl.referral_runtime_execute(text,jsonb)','EXECUTE'),
  'PUBLIC can execute referral runtime');
SELECT pg_temp.assert_referral(
  NOT has_function_privilege('public','otl.referral_admin_execute(text,jsonb)','EXECUTE'),
  'PUBLIC can execute referral admin');
SELECT pg_temp.assert_referral(
  has_function_privilege('otl_referral_runtime','otl.referral_runtime_execute(text,jsonb)','EXECUTE') AND
  NOT has_function_privilege('otl_referral_runtime','otl.referral_admin_execute(text,jsonb)','EXECUTE'),
  'runtime role boundary failed');
SELECT pg_temp.assert_referral(
  has_function_privilege('otl_referral_admin','otl.referral_admin_execute(text,jsonb)','EXECUTE') AND
  NOT has_function_privilege('otl_referral_admin','otl.referral_runtime_execute(text,jsonb)','EXECUTE'),
  'admin role boundary failed');
SELECT pg_temp.assert_referral(
  NOT has_table_privilege('otl_referral_runtime','otl.referral_requests','SELECT') AND
  NOT has_table_privilege('otl_referral_admin','otl.referral_requests','SELECT'),
  'roles can read private tables');
SELECT pg_temp.assert_referral(
  NOT has_function_privilege('public','otl.issue_invite(text,text,text,text,text)','EXECUTE') AND
  NOT has_function_privilege('public','otl.redeem_invite(text,text,text,text)','EXECUTE') AND
  NOT has_function_privilege('public','otl.check_invite(text,text,text)','EXECUTE') AND
  NOT has_function_privilege('public','otl.member_status(text,text)','EXECUTE'),
  'legacy invitation authority remains executable');
SELECT pg_temp.assert_referral(
  NOT has_function_privilege('legacy_invitation_runtime','otl.issue_invite(text,text,text,text,text)','EXECUTE') AND
  NOT has_function_privilege('legacy_invitation_runtime','otl.redeem_invite(text,text,text,text)','EXECUTE') AND
  NOT has_function_privilege('legacy_invitation_runtime','otl.check_invite(text,text,text)','EXECUTE') AND
  NOT has_function_privilege('legacy_invitation_runtime','otl.member_status(text,text)','EXECUTE'),
  'explicit legacy runtime grants survived migration');
SELECT pg_temp.assert_referral(
  NOT EXISTS(
    SELECT 1 FROM pg_roles r
    CROSS JOIN LATERAL unnest(ARRAY[
      'otl.member_status(text,text)'::regprocedure,
      'otl.issue_invite(text,text,text,text,text)'::regprocedure,
      'otl.redeem_invite(text,text,text,text)'::regprocedure,
      'otl.check_invite(text,text,text)'::regprocedure
    ]) legacy
    WHERE NOT r.rolsuper AND r.rolname<>current_user
      AND has_function_privilege(r.oid,legacy,'EXECUTE')
  ),'a non-owner runtime or app role retains legacy execute');
SELECT pg_temp.assert_referral(
  pg_get_functiondef('otl.referral_runtime_execute(text,jsonb)'::regprocedure) !~
    'issue_invite|redeem_invite|check_invite|member_status|quota_used' AND
  pg_get_functiondef('otl.referral_admin_execute(text,jsonb)'::regprocedure) !~
    'issue_invite|redeem_invite|check_invite|member_status|quota_used',
  'new referral functions reference legacy invitations');

DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE otl_referral_runtime;
    PERFORM otl.referral_admin_execute('decide','{}'::jsonb);
    RAISE EXCEPTION 'runtime called admin function';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    PERFORM pg_temp.assert_referral(true,'runtime cross-role denial');
  END;
  BEGIN
    SET LOCAL ROLE otl_referral_admin;
    PERFORM otl.referral_runtime_execute('resolve','{}'::jsonb);
    RAISE EXCEPTION 'admin called runtime function';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    PERFORM pg_temp.assert_referral(true,'admin cross-role denial');
  END;
END $$;

SELECT pg_temp.assert_referral(
  NOT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='otl' AND table_name LIKE 'referral_%'
      AND column_name IN ('email','display_name','name','intent','raw_payload','token')
  ),'plaintext applicant column exists');
SELECT pg_temp.assert_referral(
  NOT EXISTS(
    SELECT 1 FROM otl.referral_request_events
    WHERE result::text ~* 'person@example|지원자|함께 매일|opaque.envelope|opaque-nonce'
  ),'audit result contains applicant or envelope data');
SELECT pg_temp.assert_referral(
  (SELECT min(audit_purge_after-occurred_at)>=interval '12 months' FROM otl.referral_request_events),
  'audit retention is shorter than twelve months');
SELECT pg_temp.assert_referral(
  (SELECT count(*) FROM otl.member_referral_attributions WHERE team_id='TREF')=1,
  'attribution was not retained');

SELECT 'REFERRAL_STORAGE_CHECKS='||(SELECT value FROM referral_check_count);
SELECT 'PII_ROWS=0';
SELECT 'LEGACY_EXECUTE_PUBLIC=false';
