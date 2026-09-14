import assert from 'node:assert/strict';
import {mock} from 'bun:test';
const deliveries=new Map(),versions=new Set(),posts=[];
mock.module('../src/store.ts',()=>({NeonStore:class {async queryJson(sql,params){
 const p=JSON.parse(params[1]);if(params[0]==='claim') {versions.add(p.hash);if(deliveries.has(p.userId))return false;deliveries.set(p.userId,'claimed');return true;}
 deliveries.set(p.userId,p.status);return true;
}}}));
const {deliverWelcomeGuide}=await import('../src/community-guide.ts');
const env={SLACK_TEAM_ID:'TQA',SLACK_BOT_TOKEN:'fake',DATABASE_URL:'fake',COMMUNITY_WELCOME_CHANNEL_ID:'CWELCOME',COMMUNITY_GUIDE_SOURCE_TS:'123.456',COMMUNITY_ADMIN_ID:'UADMIN'};
let body='안내 <#CDAILY> <!channel>',author='UADMIN';
globalThis.fetch=async(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('users.info'))return Response.json({ok:true,user:{id:u.searchParams.get('user'),is_bot:u.searchParams.get('user')==='UBOT',deleted:false}});if(u.pathname.endsWith('conversations.history'))return Response.json({ok:true,messages:[{ts:'123.456',user:author,text:body}]});if(u.pathname.endsWith('chat.postMessage')){posts.push(JSON.parse(options.body));return Response.json({ok:true,ts:'456.789'});}throw Error('unexpected endpoint');};
const event={type:'member_joined_channel',channel:'CWELCOME',user:'UNEW'};
await deliverWelcomeGuide(event,env);await deliverWelcomeGuide({...event,type:'message',subtype:'channel_join'},env);
assert.equal(posts.length,1);assert.equal(posts[0].thread_ts,undefined);assert.match(posts[0].text,/<@UNEW>/);assert.match(posts[0].text,/<#CDAILY>/);assert.doesNotMatch(posts[0].text,/<!channel>/);
await deliverWelcomeGuide({...event,user:'UBOT'},env);await deliverWelcomeGuide({...event,channel:'COTHER'},env);assert.equal(posts.length,1);
body='새 안내';await deliverWelcomeGuide({...event,user:'UNEXT'},env);assert.equal(versions.size,2);assert.match(posts[1].text,/새 안내/);
author='UOTHER';await assert.rejects(deliverWelcomeGuide({...event,user:'UTHIRD'},env));assert.equal(posts.length,2);assert.equal(deliveries.has('UTHIRD'),false);
console.log('PASS welcome guide duplicate events, top-level member mention, no broadcast, channel/bot guards, version snapshots, source author guard');
author='UADMIN';
await Promise.all([deliverWelcomeGuide({...event,user:'URACE'},env),deliverWelcomeGuide({...event,user:'URACE'},env)]);assert.equal(posts.filter(p=>p.text.includes('<@URACE>')).length,1);
const workingFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>new URL(url).pathname.endsWith('chat.postMessage')?Response.json({ok:false,error:'channel_not_found'}):workingFetch(url,options);
await assert.rejects(deliverWelcomeGuide({...event,user:'UFAIL'},env));assert.equal(deliveries.get('UFAIL'),'failed');
globalThis.fetch=workingFetch;await deliverWelcomeGuide({...event,user:'UFAIL'},env);assert.equal(posts.some(p=>p.text.includes('<@UFAIL>')),false);
console.log('PASS concurrent delivery claim and failed send held without duplicate retry');
body='*ONE THING* 원씽 onthing <https://example.com/onething|원본 링크> HTTPS://example.com/onething';await deliverWelcomeGuide({...event,user:'UBRAND'},env);const branded=posts.at(-1).text;assert.doesNotMatch(branded,/\*\*ONE THING\*\*/);assert.match(branded,/<https:\/\/example.com\/onething\|원본 링크>/);assert.match(branded,/HTTPS:\/\/example.com\/onething/);console.log('PASS guide branding preserves already bold name and lower/uppercase links');
