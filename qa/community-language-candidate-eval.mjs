import {readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {classifyCommunityIntent} from '../src/community-language.ts';
const today=new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);
const token=readFileSync(`${homedir()}/.config/.wrangler/config/default.toml`,'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if(!token) throw new Error('Wrangler OAuth required');
const calls=[];
const ai={async run(model,input){
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/1216831373fd0ae2b3e7c2b6641bee46/ai/run/${model}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
 const body=await response.json();
 if(!response.ok||!body.success) throw new Error(`HTTP ${response.status}`);
 calls.push({model,result:body.result});return body.result;
}};
const results=[];
for(const text of ['논문 절반 읽었어요. 어려워서 시간이 부족했어요','논문 못 읽었어요. 회의 때문에 시간이 없었네요']){
 const actual=await classifyCommunityIntent(ai,{goal:'논문 읽기',text,date:today,today});results.push({text,actual});
}
writeFileSync(new URL('community-language-candidate-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),scope:'Two previously observed development failures; not heldout',results,calls},null,2)+'\n');
console.log(JSON.stringify(results));
