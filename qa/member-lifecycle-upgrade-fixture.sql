INSERT INTO otl.workspaces(team_id,primary_goal_channel_id) VALUES('TLIFE',NULL);
INSERT INTO otl.workspace_channels(team_id,channel_id,membership_observed_at)
VALUES('TLIFE','CLIFE','2026-09-19T14:59:59Z');
UPDATE otl.workspaces SET primary_goal_channel_id='CLIFE' WHERE team_id='TLIFE';
INSERT INTO otl.workspace_members(
  team_id,user_id,display_name,is_bot,is_app_user,slack_deleted,directory_synced_at,first_observed_at
) VALUES
  ('TLIFE','UACTIVE','Active',false,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UCONCURRENT','Concurrent',false,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UGOAL','Goal',false,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UOUTCOME','Outcome',false,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UREFLECTION','Reflection',false,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UREST','Rest',false,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UBOT','Bot',true,false,false,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z'),
  ('TLIFE','UDELETED','Deleted',false,false,true,'2026-09-19T14:59:59Z','2026-09-01T00:00:00Z');
INSERT INTO otl.workspace_channel_memberships(
  team_id,channel_id,user_id,is_current,last_seen_at,synced_at
) SELECT 'TLIFE','CLIFE',user_id,true,'2026-09-19T14:59:59Z','2026-09-19T14:59:59Z'
  FROM otl.workspace_members WHERE team_id='TLIFE';
INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,reflection,resting)
VALUES('TLIFE','CLIFE','UACTIVE','2026-09-18','preserved goal','complete','preserved reflection',false);
INSERT INTO otl.community_events(team_id,channel_id,user_id,event_key,day,before_state,after_revision,result)
VALUES('TLIFE','CLIFE','UACTIVE','preserved-event','2026-09-18','{}',1,'{}');
