import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
process.loadEnvFile('.dev.vars');
if(process.argv[2]!=='--apply') throw new Error('Use --apply after backup and maintenance activation');
const probe=await fetch(process.env.PUBLIC_BASE_URL+'/slack/events',{method:'POST',body:'maintenance-probe'});
if(probe.status!==503) throw new Error('Worker maintenance must be active before migration');
const u=new URL(process.env.DATABASE_URL);
const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:u.pathname.slice(1),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'20'};
const pg='/opt/homebrew/opt/libpq/bin/psql';
const args=['-X','-q','-v','ON_ERROR_STOP=1'];
try {
 const result=execFileSync(pg,[...args,'--single-transaction','-f','migrations/006_normalized_foundation.sql','-f','migrations/007_normalized_legacy.sql','-f','qa/normalization-invariants.sql'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 writeFileSync('.omx/qa/normalization/production-migration.txt',result);
 console.log('PASS production atomic migration and original-payload invariants');
} catch(error) {console.error(error.stderr?.toString()??error.message);process.exitCode=1;}
