import assert from 'node:assert/strict';
import {adminCommand,captureFeedback,publishRelease,releasePreview} from '../src/community-admin.ts';
import {RELEASES} from '../src/community-releases.ts';
const records=new Map();const sent=[];let sequence=0;
const identity=x=>JSON.stringify([x.teamId,x.channelId,x.userId,x.key]);
const store={
 async getRecord(x){return records.get(identity(x))??null;},
 async putRecord(x){if(!records.has(identity(x)))records.set(identity(x),{...x,status:'pending'});return records.get(identity(x));},
 async claimRecord(x){const r=records.get(identity(x));if(r?.status!=='pending')return false;r.status='claimed';return true;},
 async finishRecord(x,status){const r=records.get(identity(x));if(r?.status!=='claimed')return false;r.status=status;return true;},
 async listRecords(scope,kind){return [...records.values()].filter(r=>r.teamId===scope.teamId&&r.channelId===scope.channelId&&r.userId===scope.userId&&r.kind===kind);},
};
const scope={teamId:'TQA',channelId:'CQA',userId:'UADMIN'};
const env={SLACK_TEAM_ID:'TQA',SLACK_BOT_TOKEN:'test',COMMUNITY_ADMIN_ID:'UADMIN',COMMUNITY_CHANNEL_ID:'CQA',COMMUNITY_RELEASE_CHANNEL_ID:'CTOWN'};
const ctx={env,scope,store,date:'2026-09-11',thread:'1.000001',source:'2.000001',key:'qa'};
const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{assert.equal(url,'https://slack.com/api/chat.postMessage');sent.push(JSON.parse(options.body));return Response.json({ok:true,ts:`${++sequence}.000001`});};
try{
 const welcomeRelease=RELEASES.find(item=>item.version==='v0.0.55');assert.equal(welcomeRelease.text.match(/<!channel>/g)?.length,1,'latest welcome release announcement has one channel notification');
 await store.putRecord({...scope,key:'verified-release:v0.0.1',kind:'qa_approval',body:{verified:true}});
 await adminCommand(ctx,'업데이트 관리');
 for(const block of sent.at(-1).blocks??[]){if(block.type==='actions'){const ids=block.elements.map(e=>e.action_id);assert.equal(new Set(ids).size,ids.length,'Slack action IDs must be unique within each block');}}
 await releasePreview(ctx,'v0.0.1');
 const button=sent.at(-1).blocks.find(b=>b.type==='actions').elements[0];const key=JSON.parse(button.value).key;
 assert.match(key,/^release-preview:/,'preview must bind target and content, not carry a bare version');
 await assert.rejects(()=>publishRelease(ctx,'v0.0.1','old'),/미리보기|요청/);
 await assert.rejects(()=>publishRelease({...ctx,env:{...env,COMMUNITY_RELEASE_CHANNEL_ID:'COTHER'}},key,'changed'),/미리보기|대상|변경/);
 assert.equal(sent.filter(m=>m.channel==='CTOWN').length,0);
 const preview=await store.getRecord({...scope,key});
 const oldExpiry=preview.body.expiresAt;preview.body.expiresAt=Date.now()-1;
 await assert.rejects(()=>publishRelease(ctx,key,'expired'),/미리보기|만료/);preview.body.expiresAt=oldExpiry;
 await assert.rejects(()=>publishRelease({...ctx,scope:{...scope,userId:'UOTHER'}},key,'other'),/운영자/);
 await publishRelease(ctx,key,'publish');await publishRelease(ctx,key,'repeat');
 assert.equal(sent.filter(m=>m.channel==='CTOWN').length,1);
 const release=[...records.values()].find(r=>r.kind==='release');assert.equal(release.channelId,'CTOWN');
 const feedbackCtx={...ctx,scope:{...scope,channelId:'CTOWN',userId:'UMEMBER'},thread:release.body.ts,source:'99.000001'};
 assert.equal(await captureFeedback(feedbackCtx,'알림이 편해졌어요'),true);
 assert.equal(await captureFeedback(feedbackCtx,'알림이 편해졌어요'),true);
 const feedback=[...records.values()].filter(r=>r.kind==='feedback');assert.equal(feedback.length,1);assert.equal(feedback[0].body.authorId,'UMEMBER');
 await adminCommand(ctx,'피드백 보기');assert.match(sent.at(-1).text,/알림이 편해졌어요/);
 assert.equal(await captureFeedback({...feedbackCtx,thread:'unrelated'},'잡담'),false);
 console.log('PASS townhall: bound preview, old/changed/expired/nonowner blocked, one publication, cross-channel feedback lookup, no real Slack calls');
}finally{globalThis.fetch=originalFetch;}
