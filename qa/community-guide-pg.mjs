import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
async function execute(database,name,op,value){const {stdout}=await psql(database,["-Atc",`SELECT otl.${name}('${op}',convert_from(decode('${payload(value)}','base64'),'UTF8')::jsonb)`]);return JSON.parse(stdout.trim());}
const legacy=(database,op,value)=>execute(database,"guide_execute",op,value);
const admin=(database,op,value)=>execute(database,"guide_admin_execute",op,value);
const runtime=(database,op,value)=>execute(database,"guide_runtime_execute",op,value);
const guideHash=(body,fileIds)=>createHash("sha256").update(JSON.stringify({version:1,body,orderedFileIds:fileIds})).digest("hex");
const release=(version,editedTs,fileIds=["FLOGO1","FDAILY2"],body="safe guide")=>({teamId:"TQA",channelId:"CQA",version,hash:guideHash(body,fileIds),body,authorId:"UADMIN",sourceTs:"100.100",editedTs,orderedFileIds:fileIds});
try{
 await run("mkdir",["-p",socket]);await run(join(pgBin,"initdb"),["-D",data,"--no-locale","--encoding=UTF8","--auth=trust"]);
 await run(join(pgBin,"pg_ctl"),["-D",data,"-o",`-F -k ${socket} -p ${port}`,"-l",join(temp,"postgres.log"),"-w","start"]);started=true;
 await run(join(pgBin,"createdb"),["upgrade"]);await run(join(pgBin,"createdb"),["fresh"]);
 await applyThrough009("upgrade");
 await legacy("upgrade","claim",{teamId:"TQA",channelId:"CQA",userId:"ULEGACY",hash:"a".repeat(64),body:"old",authorId:"UADMIN",sourceTs:"90.1",editedTs:"90.1"});
 await legacy("upgrade","finish",{teamId:"TQA",channelId:"CQA",userId:"ULEGACY",status:"sent",messageTs:"90.2"});
 await apply("upgrade",migrations.filter(name=>Number(name.slice(0,3))>9&&Number(name.slice(0,3))<39));
 await applyThrough009("fresh");await apply("fresh",migrations.filter(name=>Number(name.slice(0,3))>9));
 const prepare=async(database)=>psql(database,["-Atc","INSERT INTO otl.workspaces(team_id) VALUES('TQA') ON CONFLICT DO NOTHING; INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('TQA','CQA') ON CONFLICT DO NOTHING; INSERT INTO otl.workspace_members(team_id,user_id) VALUES('TQA','UADMIN') ON CONFLICT DO NOTHING; INSERT INTO otl.guide_publishers(team_id,channel_id,user_id) VALUES('TQA','CQA','UADMIN') ON CONFLICT DO NOTHING"]);
 await prepare("upgrade"); await prepare("fresh");
 const old=release("v0.0.55","100.100");
 assert.equal(await admin("upgrade","publish",old),old.hash);
 await apply("upgrade",["039_bot_owned_welcome_guide.sql"]);
 assert.equal((await psql("upgrade",["-Atc","SELECT status||':'||source_origin||':'||source_ts FROM otl.guide_versions WHERE guide_version='v0.0.55'"])).stdout.trim(),"published:slack:100.100");
 assert.equal((await psql("upgrade",["-Atc","SELECT status||':'||delivery_reason FROM otl.guide_deliveries WHERE user_id='ULEGACY'"])).stdout.trim(),"sent:legacy");
 const repo=(version,body)=>{const ids=["FLOGO1","FDAILY2"];return {teamId:"TQA",channelId:"CQA",version,hash:guideHash(body,ids),body,authorId:"UADMIN",origin:"repo",orderedFileIds:ids};};
 for(const database of ["upgrade","fresh"]){
  const first=repo("v0.0.56","v0.0.56 repo guide");
  assert.equal(await admin(database,"publish",first),first.hash);
  assert.equal(await admin(database,"publish",first),first.hash);
  await assert.rejects(admin(database,"publish",{...first,body:"changed"}),/Guide canonical hash mismatch|Guide version conflict/);
  await assert.rejects(admin(database,"publish",{...first,sourceTs:"100.100"}),/Invalid published guide/);
  await assert.rejects(admin(database,"publish",{...first,origin:"slack"}),/Invalid published guide/);
  await assert.rejects(admin(database,"publish",{...first,hash:"f".repeat(64)}),/Guide canonical hash mismatch/);
  await assert.rejects(admin(database,"publish",repo("v0.0.55","older")),/Guide version must increase|Guide version conflict/);
  assert.deepEqual(await runtime(database,"latest",{teamId:"TQA",channelId:"CQA"}),{version:first.version,hash:first.hash,body:first.body,orderedFileIds:first.orderedFileIds});
  const delivery={teamId:"TQA",channelId:"CQA",userId:"USAME",version:first.version,hash:first.hash};
  assert.equal(await runtime(database,"claim",delivery),true);
  assert.equal(await runtime(database,"claim",delivery),false);
  assert.equal(await runtime(database,"finish",{...delivery,status:"sent",messageTs:"100.200"}),true);
  const second=repo("v0.0.57","v0.0.57 repo guide");
  assert.equal(await admin(database,"publish",second),second.hash);
  const corrected={...delivery,version:second.version,hash:second.hash};
  const claims=await Promise.all([admin(database,"repair_claim",corrected),admin(database,"repair_claim",corrected)]);
  assert.deepEqual(claims.sort(),[false,true]);
  assert.equal(await admin(database,"repair_finish",{...corrected,status:"sent",messageTs:"101.200"}),true);
  assert.equal((await psql(database,["-Atc","SELECT count(*) FROM otl.guide_versions WHERE status='published'"])).stdout.trim(),"1");
  assert.equal((await psql(database,["-Atc","SELECT count(*) FROM otl.guide_versions WHERE guide_version='v0.0.56' AND source_origin='repo' AND source_ts IS NULL AND source_edited_ts IS NULL"])).stdout.trim(),"1");
 }
 console.log("PASS migration039 fresh/upgrade preserve 009/028 history, immutable repo releases, ordered files, role delivery claims");
}finally{if(started)await run(join(pgBin,"pg_ctl"),["-D",data,"-m","fast","-w","stop"]);await rm(temp,{recursive:true,force:true});}
