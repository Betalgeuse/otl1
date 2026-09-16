BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION otl.bug_backfill_private_incidents_021() RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,otl AS $$
DECLARE report record; processed integer:=0;
BEGIN
  LOOP
    report:=NULL;
    SELECT candidate.* INTO report
    FROM (
      SELECT r.bug_id,r.packet_revision
      FROM otl.bug_reports r
      JOIN otl.bug_report_revisions current_revision
        ON current_revision.bug_id=r.bug_id AND current_revision.packet_revision=r.packet_revision
      WHERE (r.state='private_incident' OR r.privacy OR r.impact='security_privacy'
          OR coalesce((current_revision.sanitized_fields->>'privacy')::boolean,false)
          OR current_revision.sanitized_fields->>'impact'='security_privacy')
        AND (
          r.title<>'[private incident]' OR r.actual IS NOT NULL OR r.expected IS NOT NULL
          OR r.steps<>'[]'::jsonb OR r.location IS NOT NULL OR r.deployed_version IS NOT NULL
          OR NOT r.privacy OR r.public_export_enabled
          OR EXISTS(
            SELECT 1 FROM otl.bug_report_revisions rev WHERE rev.bug_id=r.bug_id
              AND (rev.sanitized_fields IS DISTINCT FROM jsonb_build_object(
                'privacy',true,'objectDigest',rev.object_digest
              ) OR (rev.confirmed_packet IS NOT NULL AND rev.confirmed_packet IS DISTINCT FROM
                jsonb_build_object('privacy',true,'packetDigest',rev.packet_digest,
                  'evidenceDigest',rev.evidence_digest)))
          )
          OR EXISTS(
            SELECT 1 FROM otl.bug_questions q WHERE q.bug_id=r.bug_id
              AND (q.question_text<>'[private question]'
                OR q.template_version<>'question.private.redacted.v1'
                OR q.field_name<>'actual'
                OR (q.completeness IS NOT NULL AND q.completeness<>'{"privacy":true}'::jsonb))
          )
          OR EXISTS(
            SELECT 1 FROM otl.bug_deliveries d WHERE d.bug_id=r.bug_id
              AND (d.template_id<>CASE d.delivery_kind
                WHEN 'question' THEN 'question.private.redacted.v1'
                WHEN 'summary' THEN 'summary.private.redacted.v1'
                WHEN 'receipt' THEN 'receipt.private.v1'
                ELSE 'admin_handoff.private.v1' END
                OR d.renderer_version NOT IN (
                  'bug-question.v1','bug-summary.v1','bug-receipt.v1','bug-handoff.v1',
                  'bug-private-redacted.v1'
                ))
          )
          OR NOT EXISTS(
            SELECT 1 FROM otl.bug_deliveries d WHERE d.bug_id=r.bug_id
              AND d.packet_revision=r.packet_revision AND d.delivery_kind='receipt'
              AND d.destination='reporter_ephemeral'
          )
          OR NOT EXISTS(
            SELECT 1 FROM otl.bug_deliveries d WHERE d.bug_id=r.bug_id
              AND d.packet_revision=r.packet_revision AND d.delivery_kind='admin_handoff'
              AND d.destination='admin_channel'
          )
        )
      ORDER BY r.created_at,r.bug_id
      FOR UPDATE OF r SKIP LOCKED
      LIMIT 100
    ) candidate
    ORDER BY candidate.bug_id
    LIMIT 1;
    EXIT WHEN report IS NULL;
    UPDATE otl.bug_reports SET
      title='[private incident]',actual=NULL,expected=NULL,steps='[]'::jsonb,
      location=NULL,deployed_version=NULL,privacy=true,public_export_enabled=false,
      updated_at=clock_timestamp()
    WHERE bug_id=report.bug_id;
    UPDATE otl.bug_report_revisions SET
      sanitized_fields=jsonb_build_object('privacy',true,'objectDigest',object_digest),
      confirmed_packet=CASE WHEN confirmed_packet IS NULL THEN NULL ELSE
        jsonb_build_object('privacy',true,'packetDigest',packet_digest,
          'evidenceDigest',evidence_digest) END
    WHERE bug_id=report.bug_id;
    UPDATE otl.bug_questions SET
      field_name='actual',template_version='question.private.redacted.v1',
      question_text='[private question]',
      completeness=CASE WHEN completeness IS NULL THEN NULL ELSE '{"privacy":true}'::jsonb END
    WHERE bug_id=report.bug_id;
    UPDATE otl.bug_deliveries SET
      template_id=CASE delivery_kind
        WHEN 'question' THEN 'question.private.redacted.v1'
        WHEN 'summary' THEN 'summary.private.redacted.v1'
        WHEN 'receipt' THEN 'receipt.private.v1'
        ELSE 'admin_handoff.private.v1' END,
      renderer_version=CASE WHEN renderer_version IN (
        'bug-question.v1','bug-summary.v1','bug-receipt.v1','bug-handoff.v1'
      ) THEN renderer_version ELSE 'bug-private-redacted.v1' END,
      field_name=CASE WHEN delivery_kind='question' THEN 'actual' END,
      message_ts=CASE WHEN status='sent' THEN '[private-message]' END,
      updated_at=clock_timestamp()
    WHERE bug_id=report.bug_id;
    PERFORM otl.bug_commit_private(
      report.bug_id,'system:private-backfill:021:'||report.packet_revision,clock_timestamp()
    );
    processed:=processed+1;
  END LOOP;
  RETURN to_jsonb(processed);
END $$;

REVOKE EXECUTE ON FUNCTION otl.bug_backfill_private_incidents_021() FROM PUBLIC;
SELECT otl.bug_backfill_private_incidents_021();
INSERT INTO otl.schema_migrations(version) VALUES('021-bug-private-backfill');
COMMIT;
