import assert from 'node:assert/strict';
import {mock} from 'bun:test';
mock.module('cloudflare:workers',()=>({DurableObject:class {}}));
const records=new Map();const posts=[];
mock.module('../src/community-store.ts',()=>({CommunityStore:class {
 async putRecord(x){if(!records.has(x.userId))records.set(x.userId,{...x,status:'pending'});return records.get(x.userId);}
 async claimRecord(x){const r=records.get(x.userId);if(r?.status!=='pending')return false;r.status='claimed';return true;}
 async finishRecord(x,status){records.get(x.userId).status=status;}
}}));
const {handleCommunityEvent}=await import('../src/community-events.ts');
const env={COMMUNITY_ENABLED:'true',SLACK_TEAM_ID:'TQA',COMMUNITY_RELEASE_CHANNEL_ID:'CTOWN',COMMUNITY_INTRO_CHANNEL_ID:'CINTRO',COMMUNITY_PUBLIC_CHANNEL_ID:'CDAILY',SLACK_BOT_TOKEN:'fake',DATABASE_URL:'postgresql://test:test@test.neon.tech/db'};
const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(url.endsWith('/emoji.list'))return Response.json({ok:true,emoji:{dance:'https://img/a',party:'https://img/b',cat:'https://img/c'}});if(url.endsWith('/reactions.add'))return Response.json({ok:true});if(url.includes('/users.info?')){assert.equal(options.method,'GET');const user=new URL(url).searchParams.get('user');return Response.json({ok:true,user:{id:user,is_bot:user==='UBOT',deleted:false,is_app_user:false}});}const body=JSON.parse(options.body);assert.ok(url.endsWith('/chat.postMessage'));posts.push(body);return Response.json({ok:true,ts:'123.123'});};
const event={type:'event_callback',team_id:'TQA',event:{type:'message',subtype:'channel_join',channel:'CTOWN',user:'UNEW',ts:'1789091995.608629'}};
try{
 await handleCommunityEvent(event,env);assert.equal(posts.length,1,'first townhall join must produce welcome');
 await handleCommunityEvent(event,env);
 await handleCommunityEvent({...event,event:{...event.event,type:'member_joined_channel',subtype:undefined}},env);
 assert.equal(posts.length,1,'duplicates across event types must not repeat welcome');
 for(const e of [{...event,team_id:'TOTHER'},{...event,event:{...event.event,channel:'COTHER'}},{...event,event:{...event.event,user:'UBOT'}}])await handleCommunityEvent(e,env);
 assert.equal(posts.length,1);assert.match(posts[0].text,/<@UNEW>/);assert.equal(posts[0].channel,'CTOWN');assert.equal(posts[0].blocks[1].elements[0].action_id,'community_introduction');assert.match(posts[0].blocks[1].elements[0].value,/UNEW/);
 console.log('PASS welcome routing: first join, duplicate, both event types, bot, wrong channel/team; no real Slack');
}finally{globalThis.fetch=original;}
