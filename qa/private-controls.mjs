import assert from 'node:assert/strict';
import { mock } from 'bun:test';
mock.module('cloudflare:workers',()=>({DurableObject:class {}}));
const publications=[];
mock.module('../src/community-records.ts',()=>({statusMessage:async()=>({text:"board"}),publishStatus:async(context,day)=>{publications.push({context,day});},applyChange:async()=>{},undoChange:async()=>{}}));
mock.module('../src/community-store.ts',()=>({CommunityStore:class {async day(scope){return {...scope,goal:'existing',outcome:'complete',revision:4};}async introduction(){return null;}}}));
const { ephemeral } = await import('../src/community-runtime.ts');
const { communityInteraction } = await import('../src/community-interactions.ts');
const env={COMMUNITY_ENABLED:'true',SLACK_TEAM_ID:'TQA',SLACK_BOT_TOKEN:'test',DATABASE_URL:'postgresql://user:pass@qa.neon.tech/db',COMMUNITY_CHANNEL_ID:'CADMIN',COMMUNITY_ADMIN_ID:'UADMIN',COMMUNITY_PUBLIC_CHANNEL_ID:'CPUBLIC'};
const payload={type:'block_actions',team:{id:'TQA'},user:{id:'UMEMBER'},container:{channel_id:'CPUBLIC',message_ts:'10.000001',thread_ts:'9.000001'},actions:[{action_id:'community_palette',value:JSON.stringify({ownerId:'UOTHER',key:'2026-09-11'}),action_ts:'11.000001'}],trigger_id:'trigger'};
let calls=[];const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});if(String(url).endsWith('/sql'))return Response.json({rows:[[JSON.stringify({startDate:'2026-09-11',goals:[],palette:{empty:'#EBEDF0',written:'#9BE9A8',complete:'#216E39'}})]]});return Response.json({ok:true,view:{id:'VQA'},message_ts:'12.000001'});};
try{
 await assert.rejects(()=>communityInteraction(payload,env,()=>{}),/본인 기록/);
 assert.equal(calls.length,0,'Wrong owner must have zero network effects');
 const own={...payload,actions:[{...payload.actions[0],value:JSON.stringify({ownerId:'UMEMBER',key:'2026-09-11'})}]};
 assert.equal((await communityInteraction(own,env,()=>{})).status,200);
 const modal=calls.find(c=>c.url.endsWith('/views.open')).body.view;
 assert.equal(modal.callback_id,'community_palette_submit');
 assert.deepEqual(JSON.parse(modal.private_metadata),{userId:'UMEMBER',channelId:'CPUBLIC',source:'10.000001',thread:'9.000001',date:'2026-09-11'});
 calls=[];
 const publishedIntroduction={
  type:'block_actions',team:{id:'TQA'},user:{id:'UMEMBER'},container:{channel_id:'CPUBLIC',message_ts:'12.000001'},
  actions:[{action_id:'community_introduction',value:JSON.stringify({ownerId:'UNEW',key:'introduction-welcome'}),action_ts:'13.000001'}],trigger_id:'intro-trigger'
 };
 assert.equal((await communityInteraction(publishedIntroduction,env,()=>{})).status,200);
 const introductionModal=calls.find(c=>c.url.endsWith('/views.open')).body.view;
 assert.equal(introductionModal.callback_id,'community_introduction_submit');
 assert.equal(JSON.parse(introductionModal.private_metadata).userId,'UMEMBER','a public welcome card opens the clicking member\'s own introduction');
 calls=[];
 const foreignIntroductionSubmission={type:'view_submission',team:payload.team,user:{id:'UOTHER'},view:{...introductionModal,id:'VINTRO',state:{values:{}}}};
 await assert.rejects(()=>communityInteraction(foreignIntroductionSubmission,env,()=>{}),/본인이 연/);
 assert.equal(calls.length,0,'a different member cannot submit another member\'s introduction modal');
 const submitted={type:'view_submission',team:payload.team,user:{id:'UOTHER'},view:{...modal,id:'VQA',state:{values:{}}}};
 await assert.rejects(()=>communityInteraction(submitted,env,()=>{}),/본인이 연/);
 assert.equal(calls.length,0);
 const values={reset:{reset:{selected_options:[]}}};
 for(const [role,color] of Object.entries({empty:'#EBEDF0',written:'#A5D8FF',complete:'#1971C2'})){
  values[role]={select:{selected_option:{value:color}}};values[`${role}_custom`]={hex:{value:null}};
 }
 const pending=[];
 const result=await communityInteraction({...submitted,user:payload.user,view:{...submitted.view,state:{values}}},env,p=>pending.push(p));
 assert.deepEqual(await result.json(),{response_action:'clear'});await Promise.all(pending);
 const write=calls.find(c=>c.url.endsWith('/sql'));
 assert.equal(write.body.params[3],'palette');assert.equal(write.body.params[1],'UMEMBER');
 assert.equal(JSON.parse(write.body.params[6]).complete,'#1971C2');
 assert.equal(publications.length,1);assert.equal(publications[0].day.goal,'existing');
 calls=[];
 await ephemeral({env,scope:{channelId:'CPUBLIC',userId:'UMEMBER'},thread:'9.000001'},{text:'private',user:'UOTHER'});
 assert.equal(calls[0].url,'https://slack.com/api/chat.postEphemeral');
 assert.equal(calls[0].body.user,'UMEMBER');assert.equal('thread_ts' in calls[0].body,false);
 const ownWithOrigin={...own,actions:[{...own.actions[0],value:JSON.stringify({ownerId:'UMEMBER',key:'2026-09-11',thread:'8.000001',source:'8.000002'})}]};
 calls=[];await communityInteraction(ownWithOrigin,env,()=>{});
 assert.equal(JSON.parse(calls.at(-1).body.view.private_metadata).thread,'8.000001');
 console.log('PASS palette ownership, modal owner guard, palette persistence/redraw, private transport and origin context');
}finally{globalThis.fetch=original;}
const {settingsCard}=await import('../src/community-controls.ts');
calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return Response.json({ok:true,message_ts:'15.000001'});};
try{await settingsCard({env,scope:{teamId:'TQA',channelId:'CPUBLIC',userId:'UMEMBER'},store:{async preferences(){return{enabled:false,goalTime:'10:00',reviewTime:'18:00'};}},date:'2026-09-11',source:'1.000001',thread:'1.000001'});assert.ok(calls.every(c=>c.url.endsWith('chat.postEphemeral')));assert.equal(calls[0].body.user,'UMEMBER');console.log('PASS personal notification settings only sent to owner');}finally{globalThis.fetch=original;}
