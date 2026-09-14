BEGIN;
DO $$ DECLARE s jsonb:=jsonb_build_object('teamId','QA-EDIT-CONTENT','channelId','private','userId','owner','date','2026-09-13');r jsonb;BEGIN
PERFORM otl.community_execute('change',s||'{"action":"goal","key":"goal","text":"original"}');
PERFORM otl.community_execute('change',s||'{"action":"reflection","key":"review","text":"original review","outcome":"complete"}');
PERFORM otl.community_execute('change',s||'{"action":"rest","key":"rest"}');
r:=otl.community_execute('change',s||'{"action":"goal","key":"edit","text":"edited","preserveOutcome":true,"expectedRevision":3}');
ASSERT r->'day'->>'goal'='edited';ASSERT r->'day'->>'outcome'='complete';ASSERT r->'day'->>'reflection'='original review';ASSERT (r->'day'->>'resting')::boolean;
r:=otl.community_execute('change',s||'{"action":"goal","key":"stale","text":"must not overwrite","preserveOutcome":true,"expectedRevision":3}');ASSERT (r->>'conflict')::boolean;
END $$;
ROLLBACK;
