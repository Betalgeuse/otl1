import fs from 'node:fs';
import {CommunityStore} from '../src/community-store.ts';
import {NeonStore} from '../src/store.ts';
import {koreaDate} from '../src/input.ts';
process.loadEnvFile('.dev.vars');const db=new NeonStore(process.env.DATABASE_URL);const store=new CommunityStore(db);const scope={teamId:process.env.SLACK_TEAM_ID,channelId:'C0C0AMK8068',userId:'U0BV52VENTD',date:koreaDate(Date.now()/1000)};const file='.omx/qa/v001-v019/review-fixture.json';
if(process.argv[2]==='prepare'){
 const before=await store.day(scope);fs.writeFileSync(file,JSON.stringify({before,temporaryRevision:before.revision+1,status:'preparing'},null,2));
 const changed=await db.queryJson('WITH x AS (UPDATE otl.community_days SET reflection=\'\',resting=false,revision=revision+1 WHERE team_id=$1 AND channel_id=$2 AND user_id=$3 AND day=$4::date AND revision=$5::integer RETURNING 1) SELECT to_jsonb(count(*)) FROM x',[scope.teamId,scope.channelId,scope.userId,scope.date,String(before.revision)]);if(changed!==1)throw Error('Fixture revision conflict');console.log('Prepared private-only review-missing fixture; public records untouched');
}else if(process.argv[2]==='restore'){
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));const b=saved.before;
 const changed=await db.queryJson('WITH x AS (UPDATE otl.community_days SET reflection=$6,resting=$7::boolean,revision=revision+1 WHERE team_id=$1 AND channel_id=$2 AND user_id=$3 AND day=$4::date AND revision=$5::integer RETURNING 1) SELECT to_jsonb(count(*)) FROM x',[scope.teamId,scope.channelId,scope.userId,scope.date,String(saved.temporaryRevision),b.reflection,String(b.resting)]);if(changed!==1)throw Error('User changed QA data; do not overwrite');saved.status='restored';fs.writeFileSync(file,JSON.stringify(saved,null,2));console.log('Private fixture restored without overwriting newer user edits');
}else throw Error('Use prepare or restore');
