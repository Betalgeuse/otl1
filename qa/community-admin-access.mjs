import assert from 'node:assert/strict';
import { mock } from 'bun:test';
mock.module('cloudflare:workers',()=>({DurableObject:class {}}));
const {adminCommand, releasePreview, publishRelease} = await import('../src/community-admin.ts');
const {groupCard, openSettings, settingsCard} = await import('../src/community-controls.ts');
const {enablePublicSchedule} = await import('../src/community-cutover.ts');
const {communityInteraction} = await import('../src/community-interactions.ts');
const env={SLACK_TEAM_ID:'TQA',COMMUNITY_ADMIN_ID:'UADMIN',COMMUNITY_CHANNEL_ID:'CADMIN',COMMUNITY_PUBLIC_CHANNEL_ID:'CPUBLIC',COMMUNITY_ENABLED:'true',DATABASE_URL:'invalid',SLACK_BOT_TOKEN:'test'};
const scope={teamId:'TQA',channelId:'CADMIN',userId:'UADMIN'};
let effects=0;const sent=[];
const store=new Proxy({}, {get:()=>async()=>{effects++;return {enabled:false,goalTime:'10:00',reviewTime:'18:00'};}});
const ctx={env,scope,store,date:'2026-09-11',source:'1.1',thread:'1.1',key:'test'};
const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{effects++;sent.push(JSON.parse(options.body));return Response.json({ok:true,ts:'1.2'});};
try {
 for(const changed of [{userId:'UMEMBER'},{channelId:'CPUBLIC'},{teamId:'TOTHER'}]) {
  const other={...ctx,scope:{...scope,...changed}};
  for(const run of [()=>adminCommand(other,'회원 현황'),()=>adminCommand(other,'업데이트 관리'),()=>adminCommand(other,'피드백 보기'),()=>groupCard(other),()=>openSettings(other,'trigger',true),()=>releasePreview(other,'v0.0.1'),()=>publishRelease(other,'key','action'),()=>enablePublicSchedule(other)]) {
   const before=effects;await assert.rejects(run,/운영자|관리/);assert.equal(effects,before,'denied operation must have no effects');
  }
 }
 const adminIds=['community_group_settings','community_group_submit','community_release_preview','community_publish','community_test_schedule','community_test_group','community_live_schedule'];
 for(const id of [...adminIds,'community_unknown']) {
  for(const actor of ['UADMIN','UMEMBER']) {
   const before=effects;
   await assert.rejects(()=>communityInteraction({type:'block_actions',team:{id:'TQA'},user:{id:actor},container:{channel_id:'CPUBLIC'},actions:[{action_id:id,value:JSON.stringify({ownerId:actor,key:'x'})}]},env,()=>{effects++;}),/운영자|관리|지원하지/);
   assert.equal(effects,before);
  }
 }
 for(const badEnv of [{...env,COMMUNITY_ADMIN_ID:undefined},{...env,COMMUNITY_CHANNEL_ID:'CPUBLIC'}]) {
  const before=effects;await assert.rejects(()=>adminCommand({...ctx,env:badEnv},'업데이트 관리'),/운영자/);assert.equal(effects,before);
 }
 for(const owner of ['UOTHER',undefined]) {
  const before=effects;
  await assert.rejects(()=>communityInteraction({type:'view_submission',team:{id:'TQA'},user:{id:'UMEMBER'},view:{callback_id:'community_settings_submit',private_metadata:JSON.stringify({channelId:'CPUBLIC',userId:owner})}},env,()=>{effects++;}),/본인이 연/);
  assert.equal(effects,before);
 }
 await settingsCard({...ctx,scope:{...scope,channelId:'CPUBLIC',userId:'UMEMBER'}});
 assert.doesNotMatch(JSON.stringify(sent.at(-1)),/community_test/);
 await settingsCard(ctx);assert.match(JSON.stringify(sent.at(-1)),/community_test_schedule/);
 await openSettings(ctx,'trigger',false);assert.equal(JSON.parse(sent.at(-1).view.private_metadata).userId,'UADMIN');
 console.log('PASS admin access: actor/team/channel guards before effects; explicit action allowlist; private QA controls; modal owner binding');
} finally {globalThis.fetch=original;}
