import assert from 'node:assert/strict';
import {generateEncouragement} from '../src/community-language.ts';
const unknown={run:async()=>({response:JSON.stringify({text:'unapproved output'})})};
for(const kind of ['goal','completion','reflection','first_goal','first_reflection','rest']) {
 const input={kind,text:'합성 검증',userId:'synthetic'};
 const first=await generateEncouragement(unknown,input);
 const second=await generateEncouragement(unknown,{...input,previous:first});
 assert.notEqual(first,second);
 const stale={run:async()=>({response:JSON.stringify({text:first.replace(/\s+\S+$/u,'')})})};
 const third=await generateEncouragement(stale,{...input,previous:first});
 assert.notEqual(first,third);
}
console.log('All 6 kinds exclude previous fallback and stale model choice');
