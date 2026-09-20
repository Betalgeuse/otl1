\set ON_ERROR_STOP on
-- Given an existing posted introduction without a confirmed name and an active referral.
SELECT otl.referral_runtime_execute('issue', '{"teamId":"TREF","userId":"UREFERRER","linkId":"LNK-NAMEQA","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","now":"2026-09-20T00:00:00Z"}'::jsonb);
DO $$
DECLARE result jsonb;
BEGIN
  result := otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb);
  IF result <> '{"available":true,"inviterName":null}'::jsonb THEN RAISE EXCEPTION 'unconfirmed name leaked: %', result; END IF;
END $$;
-- When a modal prepares a new name then aborts, the public referral remains generic.
SELECT otl.introduction_execute('prepare', '{"teamId":"TREF","userId":"UREFERRER","confirmedName":"Test Name","intro":"Existing introduction","expectedRevision":1,"token":"VIEW-ABORT"}'::jsonb);
SELECT otl.introduction_execute('abort', '{"teamId":"TREF","userId":"UREFERRER","token":"VIEW-ABORT"}'::jsonb);
DO $$
BEGIN
  IF (otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb)->>'inviterName') IS NOT NULL
  THEN RAISE EXCEPTION 'aborted name leaked'; END IF;
END $$;
-- When Slack publication completes, exactly that confirmed name becomes public.
SELECT otl.introduction_execute('prepare', '{"teamId":"TREF","userId":"UREFERRER","confirmedName":"Test Name","intro":"Existing introduction","expectedRevision":1,"token":"VIEW-FINISH"}'::jsonb);
SELECT otl.introduction_execute('finish', '{"teamId":"TREF","userId":"UREFERRER","token":"VIEW-FINISH","channelId":"CREF","messageTs":"2.000001"}'::jsonb);
DO $$
DECLARE active jsonb; unknown jsonb; paused jsonb;
BEGIN
  active := otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb);
  unknown := otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb);
  IF active <> '{"available":true,"inviterName":"Test Name"}'::jsonb THEN RAISE EXCEPTION 'confirmed name absent: %', active; END IF;
  IF unknown <> '{"available":false}'::jsonb THEN RAISE EXCEPTION 'unknown token leak: %', unknown; END IF;
  UPDATE otl.member_referral_links SET status='paused' WHERE team_id='TREF' AND link_id='LNK-NAMEQA';
  paused := otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb);
  IF paused <> '{"available":false}'::jsonb THEN RAISE EXCEPTION 'paused link leak: %', paused; END IF;
  UPDATE otl.member_referral_links SET status='active' WHERE team_id='TREF' AND link_id='LNK-NAMEQA';
  INSERT INTO otl.referral_capacity_defaults(team_id,maximum) VALUES('TREF',0)
    ON CONFLICT(team_id) DO UPDATE SET maximum=excluded.maximum;
  IF otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb) <> '{"available":false}'::jsonb
  THEN RAISE EXCEPTION 'exhausted link leak'; END IF;
  IF NOT has_function_privilege('otl_referral_runtime','otl.referral_resolve_named(jsonb)','EXECUTE')
    OR has_table_privilege('otl_referral_runtime','otl.member_introductions','SELECT')
  THEN RAISE EXCEPTION 'runtime role scope mismatch'; END IF;
END $$;

SET ROLE otl_referral_runtime;
SELECT otl.referral_resolve_named('{"teamId":"TREF","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb);
RESET ROLE;
