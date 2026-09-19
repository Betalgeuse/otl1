-- Synthetic production-shaped rows only. The release receipt stores counts and digests.
BEGIN;
INSERT INTO otl.profiles(team_id,user_id) VALUES('TLIFE','UACTIVE');
INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled)
VALUES('TLIFE','CLIFE','UACTIVE',true);
INSERT INTO otl.member_introductions(team_id,user_id,intro,channel_id,revision)
VALUES('TLIFE','UACTIVE','synthetic introduction','CLIFE',1);
INSERT INTO otl.guide_versions(team_id,channel_id,content_hash,body,author_id,source_ts,source_edited_ts)
VALUES('TLIFE','CLIFE',repeat('a',64),'synthetic guide','UACTIVE','1.000000','1.000000');
INSERT INTO otl.guide_deliveries(team_id,channel_id,user_id,content_hash,status,message_ts)
VALUES('TLIFE','CLIFE','UACTIVE',repeat('a',64),'sent','2.000000');
INSERT INTO otl.bug_reports(bug_id,team_id,public_alias,reporter_id,source,source_opaque_ref,title)
VALUES('BUG-AAAAAAAA','TLIFE','B-AAAAAAAAAA','UACTIVE','slack','synthetic-source','synthetic bug');
INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce)
VALUES('BUG-AAAAAAAA',1,'bug_intake.v1','draft','{}','synthetic-private-object',repeat('b',64),repeat('c',32),'synthetic','syntheticnonce');
COMMIT;
