import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const env={...process.env,PGHOST:'/tmp/otl-community-pg',PGPORT:'55439',PGDATABASE:'postgres'};
const dump=JSON.parse(readFileSync('.omx/qa/normalization/pre-migration-backup.json')).path;
const binary='/opt/homebrew/opt/libpq/bin/';
function psql(sql){return execFileSync(binary+'psql',['-XAt','-v','ON_ERROR_STOP=1','-d','otl_normalization','-c',sql],{env,encoding:'utf8'}).trim();}
function restore(){execFileSync('dropdb',['--if-exists','otl_normalization'],{env});execFileSync('createdb',['otl_normalization'],{env});execFileSync(binary+'pg_restore',['--no-owner','--no-acl','--exit-on-error','--dbname','otl_normalization',dump],{env});}
function apply(){return execFileSync(binary+'psql',['-X','-v','ON_ERROR_STOP=1','-d','otl_normalization','--single-transaction','-f','migrations/006_normalized_foundation.sql','-f','migrations/007_normalized_legacy.sql'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
restore();
psql("UPDATE otl.community_days SET goal='' WHERE team_id='T0BUVUKB8R5' AND channel_id='C0BVB9HSL10' AND user_id='U0BV52VENTD' AND day='2026-09-10'");
assert.throws(apply,/Blank canonical goal/);assert.equal(psql("SELECT to_regnamespace('otl_archive') IS NULL"),'t');
restore();writeFileSync('.omx/qa/normalization/local-migration.txt',apply());
execFileSync(binary+'psql',['-X','-v','ON_ERROR_STOP=1','-d','otl_normalization','-f','qa/normalization-invariants.sql'],{env,stdio:['ignore','pipe','pipe']});
assert.throws(apply,/already exists/);assert.equal(psql("SELECT count(*) FROM otl.schema_migrations"),'1');
console.log('PASS restore rehearsal, blank-source conflict aborts atomically, no original payload loss, repeat migration refuses safely');
