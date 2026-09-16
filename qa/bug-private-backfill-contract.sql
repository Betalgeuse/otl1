\set QUIET 1
DO $$
DECLARE events_before bigint; canary_rows bigint;
BEGIN
  SELECT count(*) INTO events_before FROM otl.bug_events WHERE bug_id='BUG-BACKFILL021A';
  SELECT
    (SELECT count(*) FROM otl.bug_reports r WHERE r.bug_id='BUG-BACKFILL021A'
      AND to_jsonb(r)::text LIKE '%CANARY-BACKFILL-021%')
    +(SELECT count(*) FROM otl.bug_report_revisions r WHERE r.bug_id='BUG-BACKFILL021A'
      AND (r.sanitized_fields::text||coalesce(r.confirmed_packet::text,'')) LIKE '%CANARY-BACKFILL-021%')
    +(SELECT count(*) FROM otl.bug_questions q WHERE q.bug_id='BUG-BACKFILL021A'
      AND (q.question_text||coalesce(q.completeness::text,'')) LIKE '%CANARY-BACKFILL-021%')
    +(SELECT count(*) FROM otl.bug_deliveries d WHERE d.bug_id='BUG-BACKFILL021A'
      AND to_jsonb(d)::text LIKE '%CANARY-BACKFILL-021%')
  INTO canary_rows;
  IF canary_rows<>0 THEN RAISE EXCEPTION 'private canary survived upgrade: %',canary_rows; END IF;
  IF (SELECT count(*) FROM otl.bug_report_revisions WHERE bug_id='BUG-BACKFILL021A'
      AND ((packet_revision=1 AND opaque_ref='bugs/backfill021/revision-1.enc' AND object_digest=repeat('a',64))
        OR (packet_revision=2 AND opaque_ref='bugs/backfill021/revision-2.enc' AND object_digest=repeat('b',64))
        OR (packet_revision=3 AND opaque_ref='bugs/backfill021/revision-3.enc' AND object_digest=repeat('c',64))))<>3
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-BACKFILL021A')<>events_before
  THEN RAISE EXCEPTION 'opaque private lineage or append-only events changed'; END IF;
  IF (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-BACKFILL021A'
      AND packet_revision=3 AND delivery_kind='receipt' AND destination='reporter_ephemeral')<>1
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-BACKFILL021A'
      AND packet_revision=3 AND delivery_kind='admin_handoff' AND destination='admin_channel')<>1
     OR EXISTS(SELECT 1 FROM otl.bug_jobs WHERE bug_id='BUG-BACKFILL021A')
  THEN RAISE EXCEPTION 'private outbox duplicated or job created'; END IF;
  IF otl.bug_backfill_private_incidents_021()<>'0'::jsonb
     OR (SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-BACKFILL021A'
       AND delivery_kind IN ('receipt','admin_handoff'))<>2
     OR (SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-BACKFILL021A')<>events_before
  THEN RAISE EXCEPTION 'private backfill replay was not idempotent'; END IF;
END $$;

SELECT jsonb_build_object(
  'upgradeCanaryAbsent',true,'opaqueLineagePreserved',true,'eventsPreserved',true,
  'outboxUnique',true,'backfillReplayZero',true
);
