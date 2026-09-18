import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec=promisify(execFile),root=resolve(import.meta.dirname,".."),pgBin=process.env.PG_BIN??"/opt/homebrew/opt/postgresql@17/bin";
const temp=await mkdtemp("/tmp/otl1-guide-pg-"),data=join(temp,"data"),socket=join(temp,"socket"),port=String(60000+Math.floor(Math.random()*1000));
const env={...process.env,PGHOST:socket,PGPORT:port,PGDATABASE:"postgres"};let started=false;
const run=(bin,args,extra={})=>exec(bin,args,{cwd:root,env:{...env,...extra},encoding:"utf8"});
const psql=(database,args)=>run(join(pgBin,"psql"),["-X","-d",database,"-v","ON_ERROR_STOP=1",...args]);
const migrations=readdirSync("migrations").filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort();
async function apply(database,files){for(const file of files)await psql(database,["-f",`migrations/${file}`]);}
async function applyThrough009(database){
 await apply(database,migrations.filter(name=>Number(name.slice(0,3))<=5));
 await psql(database,["--single-transaction","-f","migrations/006_normalized_foundation.sql","-f","migrations/007_normalized_legacy.sql"]);
 await apply(database,migrations.filter(name=>[8,9].includes(Number(name.slice(0,3)))));
}
const payload=(value)=>Buffer.from(JSON.stringify(value)).toString("base64");
async function guide(database,op,value){const {stdout}=await psql(database,["-Atc",`SELECT otl.guide_execute('${op}',convert_from(decode('${payload(value)}','base64'),'UTF8')::jsonb)`]);return JSON.parse(stdout.trim());}
const release=(version,hash,editedTs,fileIds=["FLOGO1","FDAILY2"])=>({teamId:"TQA",channelId:"CQA",version,hash,body:"safe guide",authorId:"UADMIN",sourceTs:"100.100",editedTs,orderedFileIds:fileIds});
try{
 await run("mkdir",["-p",socket]);await run(join(pgBin,"initdb"),["-D",data,"--no-locale","--encoding=UTF8","--auth=trust"]);
 await run(join(pgBin,"pg_ctl"),["-D",data,"-o",`-F -k ${socket} -p ${port}`,"-l",join(temp,"postgres.log"),"-w","start"]);started=true;
 await run(join(pgBin,"createdb"),["upgrade"]);await run(join(pgBin,"createdb"),["fresh"]);
 const after009=migrations.filter(name=>Number(name.slice(0,3))>9);
 await applyThrough009("upgrade");
 await guide("upgrade","claim",{teamId:"TQA",channelId:"CQA",userId:"ULEGACY",hash:"a".repeat(64),body:"old",authorId:"UADMIN",sourceTs:"90.1",editedTs:"90.1"});
 await guide("upgrade","finish",{teamId:"TQA",channelId:"CQA",userId:"ULEGACY",status:"sent",messageTs:"90.2"});
 await apply("upgrade",after009);await applyThrough009("fresh");await apply("fresh",after009);
 assert.equal((await psql("upgrade",["-Atc","SELECT status||':'||ordered_file_ids::text FROM otl.guide_versions WHERE content_hash=repeat('a',64)"])).stdout.trim(),"historical:[]");
 assert.equal((await psql("upgrade",["-Atc","SELECT status||':'||coalesce(guide_version,'none')||':'||delivery_reason FROM otl.guide_deliveries WHERE user_id='ULEGACY'"])).stdout.trim(),"sent:none:legacy");
 for(const database of ["upgrade","fresh"]){
  const first=release("v0.0.55","b".repeat(64),"100.100");assert.equal(await guide(database,"publish",first),"b".repeat(64));assert.equal(await guide(database,"publish",first),"b".repeat(64));
  await assert.rejects(guide(database,"publish",{...first,editedTs:"100.101"}),/Guide version conflict/);
  assert.deepEqual(await guide(database,"latest",{teamId:"TQA",channelId:"CQA"}),{version:"v0.0.55",hash:"b".repeat(64),body:"safe guide",orderedFileIds:["FLOGO1","FDAILY2"]});
  const delivery={teamId:"TQA",channelId:"CQA",userId:"USAME",version:"v0.0.55",hash:"b".repeat(64),reason:"join"};
  assert.equal(await guide(database,"claim",delivery),true);
  assert.equal(await guide(database,"claim",delivery),false);
  assert.equal(await guide(database,"finish",{...delivery,version:"v0.0.54",status:"sent",messageTs:"100.200"}),false);
  assert.equal(await guide(database,"finish",{...delivery,hash:"f".repeat(64),status:"sent",messageTs:"100.200"}),false);
  assert.equal(await guide(database,"finish",{...delivery,status:"sent",messageTs:"100.200"}),true);
  await assert.rejects(guide(database,"publish",release("v0.0.55","c".repeat(64),"101.100")),/Guide version conflict/);
  await assert.rejects(guide(database,"publish",release("v0.0.56","c".repeat(64),"100.100")),/Guide source is stale/);
  assert.equal(await guide(database,"publish",release("v0.0.56","c".repeat(64),"101.100",["FDAILY2","FLOGO1"])),"c".repeat(64));
  const corrected={...delivery,version:"v0.0.56",hash:"c".repeat(64),reason:"targeted_repair"};
  const claims=await Promise.all([guide(database,"claim",corrected),guide(database,"claim",corrected)]);
  assert.deepEqual(claims.sort(),[false,true]);
  assert.equal(await guide(database,"finish",{...corrected,status:"sent",messageTs:"101.200"}),true);
  assert.equal((await psql(database,["-Atc","SELECT count(*)||':'||string_agg(guide_version||'/'||delivery_reason,',' ORDER BY guide_version) FROM otl.guide_deliveries WHERE user_id='USAME'"])).stdout.trim(),"2:v0.0.55/join,v0.0.56/targeted_repair");
  assert.equal((await psql(database,["-Atc","SELECT count(*) FROM otl.guide_versions WHERE status='published'"])).stdout.trim(),"1");
  await assert.rejects(guide(database,"publish",release("v0.0.57","d".repeat(64),"102.100",["FSAME","FSAME"])),/Invalid published guide/);
 }
 console.log("PASS migration 026 preserves legacy audit history and keys delivery by immutable version/hash with exact finish and concurrent correction safety");
}finally{if(started)await run(join(pgBin,"pg_ctl"),["-D",data,"-m","fast","-w","stop"]);await rm(temp,{recursive:true,force:true});}
