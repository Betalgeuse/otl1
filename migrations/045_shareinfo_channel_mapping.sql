BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('otl:shareinfo-channel-mapping:045',0));

INSERT INTO otl.workspace_channels(team_id,channel_id)
VALUES('T0BUVUKB8R5','C0C0RLU4RGQ')
ON CONFLICT DO NOTHING;

INSERT INTO otl.schema_migrations(version) VALUES('045-shareinfo-channel-mapping');
COMMIT;
