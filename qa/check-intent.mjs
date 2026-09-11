import assert from "node:assert/strict";
import { classifyIntent, intentRequest } from "../src/intent.ts";
import { handleIntentPilot } from "../src/intent-pilot.ts";

let calls=0;
const ai={run:async()=>{calls++;return {choices:[{message:{content:'{"intent":"reflection","outcome":"complete"}'}}]};}};
assert.deepEqual(await classifyIntent(ai,{goal:null,text:"끝났어"}),{intent:"unclear",outcome:"unknown"});
assert.deepEqual(await classifyIntent(ai,{goal:"독서",text:"다 읽었어"}),{intent:"reflection",outcome:"complete"});
const before=calls;
await classifyIntent(ai,{goal:"독서",text:"가".repeat(1001)});
assert.equal(calls,before);
assert.deepEqual(await classifyIntent({run:async()=>({choices:[]})},{goal:"독서",text:"끝"}),{intent:"unclear",outcome:"unknown"});
assert.deepEqual(await classifyIntent({run:async()=>{throw new TypeError("unavailable");}},{goal:"독서",text:"끝"}),{intent:"unclear",outcome:"unknown"});
assert.equal(intentRequest({goal:null,text:"시작"}).max_tokens,120);

const posted=[];const commands=[];const realFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{assert.equal(url,"https://slack.com/api/chat.postMessage");posted.push(JSON.parse(options.body));return Response.json({ok:true});};
const env={SLACK_TEAM_ID:"TQA",SLACK_BOT_TOKEN:"test",LLM_PILOT_CHANNEL_ID:"CQA",LLM_PILOT_USER_ID:"UQA",AI:ai,INTENT_RATE_LIMITER:{limit:async()=>({success:true})}};
const store={execute:async command=>{commands.push(command);assert.equal(command.action,"get");return {goals:[{date:command.date,text:"독서",completed:false}]};}};
const ts=String(Date.now()/1000);
const event={type:"event_callback",team_id:"TQA",event:{type:"message",channel:"CQA",user:"UQA",text:"다 읽었어",ts}};
try {
 assert.equal(await handleIntentPilot({...event,team_id:"TOTHER"},env,store),false);
 assert.equal(await handleIntentPilot({...event,event:{...event.event,channel:"COTHER"}},env,store),false);
 await handleIntentPilot({...event,event:{...event.event,user:"UOTHER"}},env,store);
 await handleIntentPilot({...event,event:{...event.event,bot_id:"BQA"}},env,store);
 await handleIntentPilot({...event,event:{...event.event,type:"app_mention"}},env,store);
 assert.equal(posted.length,0);assert.equal(commands.length,0);
 await handleIntentPilot(event,env,store);
 assert.equal(posted.length,1);assert.match(posted[0].text,/완료/);assert.match(posted[0].text,/변경하지 않았/);
 await handleIntentPilot({...event,event:{...event.event,subtype:"thread_broadcast",thread_ts:ts}},env,store);
 assert.equal(posted.length,2);assert.equal(posted[1].thread_ts,ts);
 const count=calls;
 await handleIntentPilot(event,{...env,INTENT_RATE_LIMITER:{limit:async()=>({success:false})}},store);
 assert.equal(calls,count);assert.match(posted[2].text,/횟수 제한/);
 assert.equal(commands.length,2);
} finally {globalThis.fetch=realFetch;}
console.log("PASS: classifier bounds/fallbacks, channel/actor/bot gates, broadcast replies, read-only storage, rate limit.");
