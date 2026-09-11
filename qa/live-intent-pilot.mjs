import { createHmac, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { NeonStore } from "../src/store.ts";
import { koreaDate, DEFAULT_PALETTE } from "../src/input.ts";

process.loadEnvFile(".dev.vars");
const channel="C0C0AMK8068";const user="U0BV52VENTD";
const token=process.env.SLACK_BOT_TOKEN;
const endpoint=process.env.PUBLIC_BASE_URL;
const store=new NeonStore(process.env.DATABASE_URL);
const today=koreaDate(Date.now()/1000);
const command={teamId:process.env.SLACK_TEAM_ID,userId:user,today,action:"get",date:today,text:"",palette:DEFAULT_PALETTE,eventTime:Date.now()/1000};
const before=await store.execute(command);
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function slack(method,input) {
 const read=method.startsWith("conversations.");
 const url=`https://slack.com/api/${method}${read?`?${new URLSearchParams(input)}`:""}`;
 const r=await fetch(url,{method:read?"GET":"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(read?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});
 const d=await r.json();if(!r.ok||!d.ok)throw Error(`Slack ${method}: ${d.error??r.status}`);return d;
}
const root=await slack("chat.postMessage",{channel,text:"LLM 연결 QA: 합성 문장 ‘오늘은 쉬고 내일 다시 할게요’를 서명된 테스트 이벤트로 전달합니다. 회원의 실제 제출이나 목표 변경이 아닙니다."});
const ts=String(Date.now()/1000);
const body=JSON.stringify({type:"event_callback",team_id:process.env.SLACK_TEAM_ID,event_id:`EvQA${Date.now()}`,event:{type:"message",channel,user,text:"오늘은 쉬고 내일 다시 할게요",ts,thread_ts:root.ts}});
const timestamp=String(Math.floor(Date.now()/1000));
const signature=`v0=${createHmac("sha256",process.env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
const send=sign=>fetch(`${endpoint}/slack/events`,{method:"POST",headers:{"Content-Type":"application/json","x-slack-request-timestamp":timestamp,"x-slack-signature":sign},body,signal:AbortSignal.timeout(10000)});
const unauthorized=await send("v0=invalid");assert.equal(unauthorized.status,401);
const response=await send(signature);assert.equal(response.status,200);
const duplicate=await send(signature);assert.equal(duplicate.status,200);
let replies=[];
for(let i=0;i<10;i++) {
 await new Promise(resolve=>setTimeout(resolve,1500));
 const data=await slack("conversations.replies",{channel,ts:root.ts,limit:20});
 replies=data.messages.filter(x=>x.ts!==root.ts);
 if(replies.length)break;
}
assert.equal(replies.length,1);
assert.match(replies[0].text,/오늘은 쉬겠다는 뜻/);
assert.match(replies[0].text,/변경하지 않았/);
const after=await store.execute(command);assert.equal(hash(before),hash(after));
const result={checkedAt:new Date().toISOString(),method:"synthetic signed webhook, not Slack-origin user delivery",unauthorized:unauthorized.status,accepted:response.status,duplicateAccepted:duplicate.status,observedReplies:replies.length,reply:replies[0].text,goalSnapshotUnchanged:true,thread:`https://onething1line.slack.com/archives/${channel}/p${root.ts.replace('.','')}`};
writeFileSync(new URL("llm-live-results.json",import.meta.url),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result));
