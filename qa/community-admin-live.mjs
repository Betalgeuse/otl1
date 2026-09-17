import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {writeFileSync} from 'node:fs';
process.loadEnvFile('.dev.vars');
const results=[];
for(const actor of ['U0BV52VENTD','U0OTHERQA1']) {
 for(const id of ['community_group_settings','community_group_submit','community_release_preview','community_publish','community_test_schedule','community_test_group','community_test_public_collection','community_live_schedule','community_unknown']) {
  const payload={type:'block_actions',team:{id:process.env.SLACK_TEAM_ID},user:{id:actor},container:{channel_id:'C0BVB9HSL10'},actions:[{action_id:id,value:JSON.stringify({ownerId:actor,key:'auth-qa-denied'})}]};
  const body=new URLSearchParams({payload:JSON.stringify(payload)}).toString();const ts=String(Math.floor(Date.now()/1000));
  const sig='v0='+createHmac('sha256',process.env.SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
  const response=await fetch(process.env.PUBLIC_BASE_URL+'/slack/interactions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':sig},body});
  const answer=await response.json();assert.match(answer.text,/운영자 전용|지원하지 않는 동작/);results.push({actor:actor==='U0BV52VENTD'?'admin':'synthetic-member',action:id,denied:true});
 }
}
writeFileSync('.omx/qa/admin-access/live-http.json',JSON.stringify({checkedAt:new Date().toISOString(),deployment:'c0d991f1-24d7-4675-8967-ca829697150e',surface:'signed synthetic HTTP requests, no user impersonation or public messages',results},null,2));console.log(`PASS ${results.length} deployed HTTP authorization denials`);
