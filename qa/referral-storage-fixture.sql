\set ON_ERROR_STOP on
CREATE ROLE legacy_invitation_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT EXECUTE ON FUNCTION otl.member_status(text,text),otl.issue_invite(text,text,text,text,text),
  otl.redeem_invite(text,text,text,text),otl.check_invite(text,text,text)
  TO legacy_invitation_runtime;
INSERT INTO otl.workspaces(team_id) VALUES('TREF'),('TOTHER');
INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('TREF','CREF'),('TOTHER','COTHER');
UPDATE otl.workspaces SET primary_goal_channel_id='CREF' WHERE team_id='TREF';
INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted)
VALUES
 ('TREF','UREFERRER','Referrer',false,false,false),('TREF','UADMIN','Admin',false,false,false),
 ('TREF','UBOT','Bot',true,false,false),('TREF','UDELETED','Deleted',false,false,true),
 ('TREF','UJOINED','Joined',false,false,false),('TOTHER','UOTHER','Other',false,false,false);
INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
VALUES
 ('TREF','CREF','UREFERRER',true,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UADMIN',true,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UBOT',true,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UDELETED',true,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UJOINED',true,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TOTHER','COTHER','UOTHER',true,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z');
INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
VALUES
 ('TREF','CREF','UREFERRER','active','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UADMIN','active','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UBOT','active','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UDELETED','active','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TREF','CREF','UJOINED','active','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
 ('TOTHER','COTHER','UOTHER','active','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z');
