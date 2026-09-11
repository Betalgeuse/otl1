import assert from 'node:assert/strict';
import {randomCustomEmoji,customBotEmoji} from '../src/community-emoji.ts';
const original=globalThis.fetch;let calls=0;
globalThis.fetch=async(url,options)=>{assert.equal(url,'https://slack.com/api/emoji.list');assert.equal(options.method,'GET');calls++;return Response.json({ok:true,emoji:{dance:'https://img/a',cat:'https://img/b',party:'https://img/c',standard_alias:'alias:smile'}});};
try{const names=await randomCustomEmoji('test');assert.equal(names.length,3);assert.equal(new Set(names).size,3);assert.ok(names.every(n=>['dance','cat','party'].includes(n)));const msg=await customBotEmoji('test','어서 오세요 🐧!!! :seedling:');assert.doesNotMatch(msg,/🐧|:seedling:/);assert.equal(calls,1);console.log('PASS custom catalog selection, distinct picks, alias exclusion, cache, bot text conversion');}finally{globalThis.fetch=original;}
