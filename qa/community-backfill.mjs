import fs from 'node:fs';
import {NeonStore} from '../src/store.ts';
process.loadEnvFile('.dev.vars');
const baseline=JSON.parse(fs.readFileSync('qa/community-public-baseline.json','utf8'));
const db=new NeonStore(process.env.DATABASE_URL);
const payload=JSON.stringify(baseline);
const query=`WITH input AS (SELECT $1::text AS team, $2::text AS channel, $3::jsonb AS data),
 days AS (INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,outcome,reflection,resting,revision)
 SELECT team,channel,d->>'userId',(d->>'date')::date,d->>'goal',d->>'outcome',coalesce(d->>'reflection',''),false,0
 FROM input,jsonb_array_elements(data->'days') d ON CONFLICT DO NOTHING RETURNING 1),
 source_records AS (INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
 SELECT team,channel,d->>'userId','baseline:'||(d->>'date'),'baseline',d FROM input,jsonb_array_elements(data->'days') d ON CONFLICT DO NOTHING RETURNING 1),
 known AS (INSERT INTO otl.community_milestones(team_id,channel_id,user_id,kind)
 SELECT team,channel,m->>'userId',v.kind FROM input,jsonb_array_elements(data->'milestones')m CROSS JOIN LATERAL (VALUES('first_goal','firstGoalKnown'),('first_reflection','firstReflectionKnown'))v(kind,flag)
 WHERE (m->>v.flag)::boolean ON CONFLICT DO NOTHING RETURNING 1),
 boundaries AS (INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
 SELECT team,channel,m->>'userId','history-boundary','baseline_boundary',m FROM input,jsonb_array_elements(data->'milestones')m ON CONFLICT DO NOTHING RETURNING 1)
 SELECT jsonb_build_object('days',(SELECT count(*) FROM days),'sourceRecords',(SELECT count(*) FROM source_records),'knownMilestones',(SELECT count(*) FROM known),'boundaries',(SELECT count(*) FROM boundaries))`;
const result=await db.queryJson(query,[process.env.SLACK_TEAM_ID,'C0BVB9HSL10',payload]);
fs.writeFileSync('.omx/qa/v001-v019/public-backfill.json',JSON.stringify({at:new Date().toISOString(),result,source:'qa/community-public-baseline.json',uncertain:baseline.uncertain},null,2));console.log(result);
