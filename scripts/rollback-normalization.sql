-- Forward-compatible fallback: current canonical goals, not the pre-migration snapshot.
-- Execute only in a single transaction with writes quiescent; keeps member FKs and archive.
SET LOCAL lock_timeout='5s';
LOCK TABLE otl.community_days,otl.profiles,otl.community_records,otl.channel_schedules IN ACCESS EXCLUSIVE MODE;
INSERT INTO otl.profiles(team_id,user_id,start_date) SELECT team_id,user_id,min(goal_date) FROM otl.goals GROUP BY team_id,user_id ON CONFLICT DO NOTHING;
CREATE TABLE otl.goals_restored (LIKE otl_archive.goals INCLUDING ALL);
INSERT INTO otl.goals_restored SELECT * FROM otl.goals;
DROP VIEW otl.goals;
ALTER TABLE otl.goals_restored RENAME TO goals;
ALTER TABLE otl.goals ADD FOREIGN KEY(team_id,user_id) REFERENCES otl.profiles(team_id,user_id);
INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,updated_at)
 SELECT team_id,channel_id,updated_by,'group-schedule','settings',jsonb_build_object('enabled',enabled,'goalTime',to_char(goal_time,'HH24:MI'),'reviewTime',to_char(review_time,'HH24:MI')),updated_at FROM otl.channel_schedules
 ON CONFLICT(team_id,channel_id,user_id,record_key) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at;
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('otl.community_execute_v1(text,jsonb)'::regprocedure),'otl.community_execute_v1(','otl.community_execute(');
 EXECUTE replace(pg_get_functiondef('otl.execute_v1(text,text,date,text,date,text,jsonb,numeric)'::regprocedure),'otl.execute_v1(','otl.execute(');
END $$;
UPDATE otl.schema_migrations SET version='006-007-normalization-rolled-back' WHERE version='006-007-normalization';
