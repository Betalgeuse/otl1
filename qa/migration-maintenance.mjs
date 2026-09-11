import {mock} from 'bun:test';import assert from 'node:assert/strict';
mock.module('cloudflare:workers',()=>({DurableObject:class {}}));
const {handleRequest}=await import('../src/index.ts');
let effects=0;const runtime={env:{DATABASE_MAINTENANCE:'true'},store:new Proxy({},{get(){effects++;throw new Error('Unexpected DB access');}})};
for(const path of ['events','interactions','commands']){const r=await handleRequest(new Request('https://test/slack/'+path,{method:'POST',body:'test'}),runtime,{waitUntil(){effects++;}});assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'30');}assert.equal(effects,0);
assert.equal((await handleRequest(new Request('https://test/health'),runtime,{})).status,200);
console.log('PASS migration maintenance: no database writes or ACK-success during migration, health remains available');
