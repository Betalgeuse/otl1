import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const database = process.env.COMMUNITY_PG_DATABASE ?? 'otl_post_normalization';
assert.match(database, /^otl_[a-z_]+$/, 'Only disposable local test databases are allowed');
const sql = `
BEGIN;
INSERT INTO otl.workspaces(team_id) VALUES ('QA-DEFAULT-REMINDERS');
INSERT INTO otl.workspace_channels VALUES ('QA-DEFAULT-REMINDERS','public');
UPDATE otl.workspaces SET primary_goal_channel_id='public' WHERE team_id='QA-DEFAULT-REMINDERS';
DO $$
DECLARE s jsonb:=jsonb_build_object('teamId','QA-DEFAULT-REMINDERS','channelId','public','userId','member');
 r jsonb; q jsonb; k text; candidate jsonb;
BEGIN
 r:=otl.community_execute('enroll_reminders',s);
 ASSERT r->>'enabled'='true' AND r->>'goalTime'='11:00' AND r->>'reviewTime'='20:00','new primary defaults';
 ASSERT r->>'preferenceSource'='default' AND (r->>'eligibleFrom')::date=(now() AT TIME ZONE 'Asia/Seoul')::date+1,'tomorrow eligibility';
 ASSERT otl.community_execute('due',s||jsonb_build_object('now',now()))='[]'::jsonb,'no same-day reminders';
 ASSERT otl.community_execute('preferences',s||jsonb_build_object('channelId','admin'))->>'enabled'='false','QA defaults off';
 r:=otl.community_execute('preferences',s||jsonb_build_object('userId','read-only'));
 ASSERT r->>'enabled'='true' AND r->>'preferenceSource'='default','naked primary read defaults on';
 PERFORM otl.community_execute('preferences',s||jsonb_build_object('userId','read-only','enabled',false));
 r:=otl.community_execute('enroll_reminders',s||jsonb_build_object('userId','read-only'));
 ASSERT r->>'enabled'='false' AND r->>'preferenceSource'='user','explicit opt-out preserved';
 UPDATE otl.community_preferences SET eligible_from='2030-01-07' WHERE team_id='QA-DEFAULT-REMINDERS';
 r:=otl.community_execute('due',s||jsonb_build_object('now','2030-01-07T01:59:00Z'));
 ASSERT r='[]'::jsonb,'not before 11';
 r:=otl.community_execute('due',s||jsonb_build_object('now','2030-01-07T02:00:00Z'));
 ASSERT jsonb_array_length(r)=1,'11AM goal generated'; candidate:=r->0;
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T01:59:00Z'))='false'::jsonb,'claim rechecks schedule';
 UPDATE otl.workspace_members SET is_bot=true WHERE team_id='QA-DEFAULT-REMINDERS' AND user_id='member';
 ASSERT otl.community_execute('due',s||jsonb_build_object('now','2030-01-07T02:00:00Z'))='[]'::jsonb,'bots excluded including pending';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T02:00:00Z'))='false'::jsonb,'claim rejects bot';
 UPDATE otl.workspace_members SET is_bot=false,slack_deleted=true WHERE team_id='QA-DEFAULT-REMINDERS' AND user_id='member';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T02:00:00Z'))='false'::jsonb,'claim rejects inactive';
 UPDATE otl.workspace_members SET slack_deleted=false WHERE team_id='QA-DEFAULT-REMINDERS' AND user_id='member';
 UPDATE otl.community_preferences SET eligible_from='2030-01-08' WHERE team_id='QA-DEFAULT-REMINDERS' AND user_id='member';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T02:00:00Z'))='false'::jsonb,'claim rejects future eligibility';
 UPDATE otl.community_preferences SET eligible_from='2030-01-07' WHERE team_id='QA-DEFAULT-REMINDERS' AND user_id='member';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T02:00:00Z'))='true'::jsonb,'eligible claim';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T02:00:00Z'))='false'::jsonb,'claim once';
 ASSERT otl.community_execute('due',s||jsonb_build_object('now','2030-01-12T11:00:00Z'))='[]'::jsonb,'Saturday skipped';
 ASSERT otl.community_execute('due',s||jsonb_build_object('now','2030-01-13T11:00:00Z'))='[]'::jsonb,'Sunday skipped';
 INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
 VALUES('QA-DEFAULT-REMINDERS','public','member','weekend','reminder','{"date":"2030-01-12","kind":"goal"}');
 ASSERT otl.community_execute('claim_reminder',s||jsonb_build_object('key','weekend','now','2030-01-12T11:00:00Z'))='false'::jsonb,'weekend claim denied';
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome)
 VALUES('QA-DEFAULT-REMINDERS','public','member','2030-01-07','write','complete');
 r:=otl.community_execute('due',s||jsonb_build_object('now','2030-01-07T11:00:00Z'));
 ASSERT jsonb_array_length(r)=1 AND r->0->>'kind'='review','completion still requires review'; candidate:=r->0;
 UPDATE otl.community_days SET reflection='learned' WHERE team_id='QA-DEFAULT-REMINDERS';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T11:00:00Z'))='false'::jsonb,'submitted review claim denied';
 UPDATE otl.community_days SET reflection='',resting=true WHERE team_id='QA-DEFAULT-REMINDERS';
 ASSERT otl.community_execute('due',s||jsonb_build_object('now','2030-01-07T11:00:00Z'))='[]'::jsonb,'rest suppresses reminders';
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T11:00:00Z'))='false'::jsonb,'rest claim denied';
 UPDATE otl.community_days SET resting=false WHERE team_id='QA-DEFAULT-REMINDERS';
 PERFORM otl.community_execute('preferences',s||jsonb_build_object('enabled',false));
 ASSERT otl.community_execute('claim_reminder',candidate||jsonb_build_object('now','2030-01-07T11:00:00Z'))='false'::jsonb,'disabled claim denied';
 ASSERT otl.community_execute('enroll_reminders',s)->>'enabled'='false','reenrollment preserves off';
 ASSERT otl.community_execute('preferences',s)->>'eligibleFrom'='2030-01-07','edits preserve eligibility';
 ASSERT otl.community_execute('due',s||jsonb_build_object('now','2030-01-07T13:00:00Z'))='[]'::jsonb,'22PM quiet boundary';
 ASSERT EXISTS(SELECT 1 FROM otl_archive.migration_snapshots WHERE migration='008' AND table_name='community_preferences'),'immutable source snapshot';
END $$;
ROLLBACK;
`;
execFileSync('psql', ['-h','/tmp/otl-community-pg','-p','55439','-d',database,'-X','-v','ON_ERROR_STOP=1'], {input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']});
console.log('PASS reminder SQL: defaults, enrollment, opt-out persistence, tomorrow eligibility, weekday/quiet limits, active humans, due/claim rechecks, complete vs review, rest, one claim, preserved snapshot');
