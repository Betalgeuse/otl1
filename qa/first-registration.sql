BEGIN;
DO $$ DECLARE s jsonb:=jsonb_build_object('teamId','QA-FIRST-REG','channelId','private','userId','owner','date','2026-09-14');r jsonb;BEGIN
r:=otl.community_execute('change',s||'{"action":"goal","key":"one","text":"first"}');ASSERT (r->>'firstRegistration')::boolean;ASSERT NOT (r->>'firstGoal')::boolean;
r:=otl.community_execute('change',s||'{"action":"goal","key":"one","text":"repeat"}');ASSERT NOT (r->>'firstRegistration')::boolean;
r:=otl.community_execute('change',s||'{"action":"goal","key":"edit","text":"changed","preserveOutcome":true}');ASSERT NOT (r->>'firstRegistration')::boolean;
r:=otl.community_execute('change',s||'{"action":"complete","key":"complete"}');ASSERT (r->>'firstGoal')::boolean;
r:=otl.community_execute('change',s||'{"action":"reflection","key":"reflection","text":"learned"}');ASSERT (r->>'firstReflection')::boolean;
END $$;
ROLLBACK;
