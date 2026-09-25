BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION otl.bug_admin_approve_merge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,otl AS $$
DECLARE r otl.bug_reports; change otl.git_changes; at_time timestamptz:=clock_timestamp();
BEGIN
  IF coalesce(p->>'teamId','')='' OR coalesce(p->>'bugId','')=''
     OR coalesce(p->>'adminId','')='' OR (p->>'prNumber')::bigint<1
     OR coalesce(p->>'idempotencyKey','')=''
  THEN RAISE EXCEPTION 'invalid merge approval' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM otl.bug_reports WHERE bug_id=p->>'bugId' FOR UPDATE;
  IF NOT FOUND OR r.team_id<>p->>'teamId' OR r.state<>'merge_eligible'
     OR r.packet_revision<>(p->>'packetRevision')::integer
  THEN RAISE EXCEPTION 'merge approval scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO change FROM otl.git_changes
    WHERE bug_id=r.bug_id AND pr_number=(p->>'prNumber')::bigint
    ORDER BY change_id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge change missing' USING ERRCODE='22023'; END IF;
  IF change.merge_status IN ('approved','claimed','merged') THEN
    RETURN jsonb_build_object('accepted',true,'changed',false,'status',change.merge_status,'changeId',change.change_id);
  END IF;
  IF change.merge_status<>'awaiting_approval' THEN
    RETURN jsonb_build_object('accepted',false,'changed',false,'status',change.merge_status);
  END IF;
  UPDATE otl.git_changes SET merge_status='approved',approved_by=p->>'adminId',approved_at=at_time
    WHERE change_id=change.change_id RETURNING * INTO change;
  INSERT INTO otl.bug_events(
    bug_id,idempotency_key,from_state,to_state,variant,revision,actors,guard_code,evidence,occurred_at
  ) VALUES(
    r.bug_id,p->>'idempotencyKey',r.state,r.state,'merge_approval',r.revision,
    jsonb_build_array('admin'),'merge_approved',
    jsonb_build_object('adminId',p->>'adminId','prNumber',change.pr_number),at_time
  ) ON CONFLICT(bug_id,idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('accepted',true,'changed',true,'status',change.merge_status,'changeId',change.change_id);
END $$;

INSERT INTO otl.schema_migrations(version) VALUES('055-feedback-merge-approval-timestamp');
COMMIT;
