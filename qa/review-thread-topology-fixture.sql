INSERT INTO otl.workspaces(team_id) VALUES ('T-REVIEW'),('T-OTHER');
INSERT INTO otl.workspace_channels(team_id,channel_id,membership_observed_at,complete_membership_observed_at) VALUES
  ('T-REVIEW','C-REVIEW','2026-09-18T08:00:00Z','2026-09-18T08:00:00Z'),
  ('T-OTHER','C-OTHER','2026-09-18T08:00:00Z','2026-09-18T08:00:00Z');
UPDATE otl.workspaces SET primary_goal_channel_id=CASE team_id
  WHEN 'T-REVIEW' THEN 'C-REVIEW' ELSE 'C-OTHER' END
WHERE team_id IN ('T-REVIEW','T-OTHER');
INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted,directory_synced_at) VALUES
  ('T-REVIEW','UADMIN','Admin',false,false,false,'2026-09-18T08:00:00Z'),
  ('T-REVIEW','U1','One',false,false,false,'2026-09-18T08:00:00Z'),
  ('T-REVIEW','U2','Two',false,false,false,'2026-09-18T08:00:00Z'),
  ('T-OTHER','U1','Other One',false,false,false,'2026-09-18T08:00:00Z');
INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at) VALUES
  ('T-REVIEW','C-REVIEW','UADMIN',true,'2026-09-18T08:00:00Z','2026-09-18T08:00:00Z'),
  ('T-REVIEW','C-REVIEW','U1',true,'2026-09-18T08:00:00Z','2026-09-18T08:00:00Z'),
  ('T-REVIEW','C-REVIEW','U2',true,'2026-09-18T08:00:00Z','2026-09-18T08:00:00Z'),
  ('T-OTHER','C-OTHER','U1',true,'2026-09-18T08:00:00Z','2026-09-18T08:00:00Z');
INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source,eligible_from,goal_time,review_time) VALUES
  ('T-REVIEW','C-REVIEW','U1',true,'default','2026-09-18','10:00','18:00'),
  ('T-REVIEW','C-REVIEW','U2',true,'default','2026-09-18','10:00','18:00');
INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status) VALUES
  ('T-REVIEW','C-REVIEW','UADMIN','common:2026-09-18:review','dispatch',
    '{"date":"2026-09-18","kind":"review","text":"review","messageTs":"1800.1"}','sent'),
  ('T-REVIEW','C-REVIEW','UADMIN','prompt:1800.1','prompt',
    '{"date":"2026-09-18","kind":"review"}','pending'),
  ('T-REVIEW','C-REVIEW','UADMIN','common-thread:2026-09-18:review','prompt',
    '{"date":"2026-09-18","kind":"review","ts":"1800.1"}','pending'),
  ('T-REVIEW','C-REVIEW','UADMIN','common-thread:2026-09-18:goal','prompt',
    '{"date":"2026-09-18","kind":"goal","ts":"1000.1"}','pending'),
  ('T-OTHER','C-OTHER','U1','common-thread:2026-09-18:review','prompt',
    '{"date":"2026-09-18","kind":"review","ts":"9999.1"}','pending');
