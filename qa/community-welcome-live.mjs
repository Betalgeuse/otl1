import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {writeFileSync} from 'node:fs';
process.loadEnvFile('.dev.vars');
async function history(){const r=await fetch('https://slack.com/api/conversations.history',{method:'POST',headers:{Authorization:'Bearer '+process.env.SLACK_BOT_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({channel:'C0C0621V0QZ',limit:30})});const d=await r.json();assert.equal(d.ok,true);return d.messages.filter(m=>m.user==='U0C0ASC06BW'&&m.text.includes('<@U0C0YB1KWP7>'));}
const before=await history();assert.equal(before.length,1);
for(const type of ['message','member_joined_channel']){
 const body=JSON.stringify({type:'event_callback',team_id:process.env.SLACK_TEAM_ID,event_id:'qa-welcome-'+type,event:{type,...(type==='message'?{subtype:'channel_join'}:{}),channel:'C0C0621V0QZ',user:'U0C0YB1KWP7',ts:'1789091995.608629'}});
 const ts=String(Math.floor(Date.now()/1000));const signature='v0='+createHmac('sha256',process.env.SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
 const r=await fetch(process.env.PUBLIC_BASE_URL+'/slack/events',{method:'POST',headers:{'Content-Type':'application/json','x-slack-request-timestamp':ts,'x-slack-signature':signature},body});assert.equal(r.status,200);
}
await new Promise(resolve=>setTimeout(resolve,7000));const after=await history();assert.equal(after.length,1);
writeFileSync('.omx/qa/townhall-welcome/live.json',JSON.stringify({checkedAt:new Date().toISOString(),deployment:'df6cf612-51c2-43d3-910d-af6cda661c74',welcomeTs:after[0].ts,readback:true,replayedBothTypes:true,duplicateCount:after.length-1,limit:'Synthetic signed replay of real join; next organic join not yet observed'},null,2));console.log('PASS real welcome readback; two deployed event replays caused no duplicate');
