DO $$ DECLARE tab text; differences integer; BEGIN
 FOREACH tab IN ARRAY ARRAY['profiles','community_days','community_events','community_milestones','community_preferences'] LOOP
  EXECUTE format('SELECT count(*) FROM (SELECT value AS row FROM jsonb_array_elements((SELECT rows FROM otl_archive.migration_snapshots WHERE migration=''006'' AND table_name=%L)) EXCEPT SELECT to_jsonb(x)-''last_event_time'' FROM otl.%I x) d',tab,tab) INTO differences;
  IF differences<>0 THEN RAISE EXCEPTION 'Original rows changed in %: %',tab,differences; END IF;
 END LOOP;
 SELECT count(*) INTO differences FROM jsonb_array_elements((SELECT rows FROM otl_archive.migration_snapshots WHERE migration='006' AND table_name='community_records')) original
 WHERE original->>'record_key'<>'group-schedule' AND NOT EXISTS(SELECT 1 FROM otl.community_records r WHERE to_jsonb(r)=original);
 IF differences<>0 THEN RAISE EXCEPTION 'Workflow records lost: %',differences; END IF;
 SELECT count(*) INTO differences FROM jsonb_array_elements((SELECT rows FROM otl_archive.migration_snapshots WHERE migration='006' AND table_name='community_records')) original
 WHERE original->>'record_key'='group-schedule' AND NOT EXISTS(SELECT 1 FROM otl.channel_schedules s
 WHERE s.team_id=original->>'team_id' AND s.channel_id=original->>'channel_id' AND s.updated_by=original->>'user_id'
 AND s.enabled=(original->'body'->>'enabled')::boolean AND s.goal_time=(original->'body'->>'goalTime')::time AND s.review_time=(original->'body'->>'reviewTime')::time);
 IF differences<>0 THEN RAISE EXCEPTION 'Schedule migration mismatch: %',differences; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace='otl'::regnamespace AND NOT convalidated) THEN RAISE EXCEPTION 'Unvalidated constraint'; END IF;
 IF EXISTS(SELECT 1 FROM otl.goals g LEFT JOIN otl.workspace_members m USING(team_id,user_id) WHERE m.user_id IS NULL) THEN RAISE EXCEPTION 'Orphan goal'; END IF;
 IF EXISTS(SELECT 1 FROM otl.community_records WHERE record_key='group-schedule') THEN RAISE EXCEPTION 'Duplicate schedule source'; END IF;
END $$;
SELECT jsonb_build_object('original_payloads_preserved',true,'schedule_source','channel_schedules','goal_source','community_days','original_conflicts_archived',(SELECT count(*) FROM otl_archive.goal_reconciliation),'validated_foreign_keys',(SELECT count(*) FROM pg_constraint WHERE connamespace='otl'::regnamespace AND contype='f'));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM otl_archive.goals old LEFT JOIN otl.goals current USING(team_id,user_id,goal_date)
 WHERE current.user_id IS NULL) THEN RAISE EXCEPTION 'Legacy goal missing from canonical history'; END IF;
END $$;
