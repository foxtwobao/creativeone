import { test,before,after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { SessionManager } from "@earendil-works/pi-coding-agent";

if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated database required');
Object.assign(process.env,{DATABASE_URL:process.env.TEST_DATABASE_URL,APP_ORIGIN:'http://localhost:3001',APP_ORIGINS:'["http://localhost:3001"]',APP_DOMAIN_SUFFIXES:'',ONE_NAVIGATION_CONFIG:'',IDONE_ISSUER:'https://idone.test',IDONE_DISCOVERY_URL:'',IDONE_CLIENT_ID:'test',IDONE_CLIENT_SECRET:'test',ADMIN_SUBJECTS:'test',ENHANCER_BASE_URL:'https://enhancer.test',ENHANCER_APP_CREDENTIAL:'test',TOKENONE_BASE_URL:'https://tokenone.test'});
const {db,initializeDatabase}=await import('./db.js');
const {migrateAgentPi}=await import('../scripts/migrate-agent-pi.mjs');
const directory=await mkdtemp(join(tmpdir(),'creativeone-pi-migration-'));
let client:pg.Client;
before(async()=>{await initializeDatabase();client=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await client.connect();});
after(async()=>{await client.end();await db.end();await rm(directory,{recursive:true,force:true});});
async function fixture(status='waiting_confirmation'){
    const user=randomUUID(),project=randomUUID(),thread=randomUUID(),id=randomUUID();
    await db.query("INSERT INTO users VALUES($1::uuid,'https://idone.test',$1::text,$2,true,'test','test','')",[user,`${user}@example.test`]);
    await db.query("INSERT INTO canvas_projects(id,user_id,title) VALUES($1,$2,'migration')",[project,user]);
    await db.query("INSERT INTO agent_threads(id,user_id,project_id,title,active_run_id) VALUES($1,$2,$3,'migration',$4)",[thread,user,project,id]);
    const context=[{role:'user',content:'原始完整目标'},{role:'assistant',content:'已读取原文'}];
    await db.query("INSERT INTO agent_runs(id,thread_id,user_id,submission_id,protocol_version,storage_version,input,model_config,context,status,revision,generation_revision,wait) VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8,1,0,$9)",[id,thread,user,randomUUID(),JSON.stringify({goal:'原始完整目标'}),JSON.stringify({model:'test',limits:{}}),JSON.stringify(context),status,JSON.stringify({type:'media',callId:'pending',manifest:{hash:'original'}})]);
    return {id,thread,user,context};
}
test('Pi migration backs up originals, preserves pending calls and is idempotent',async()=>{
    const f=await fixture(),decision={messages:[{role:'assistant',content:[{type:'tool-call',toolCallId:'pending',toolName:'submit_generation',input:{nodeIds:['original']}}]}],calls:[{toolCallId:'pending',toolName:'submit_generation',input:{nodeIds:['original']}}]};
    await db.query("INSERT INTO agent_steps(run_id,step,item_id,status,request,decision) VALUES($1,1,$2,'decided','{}',$3)",[f.id,randomUUID(),JSON.stringify(decision)]);
    const result=await migrateAgentPi(client,directory),backup=JSON.parse(await readFile(result.backup,'utf8'));
    assert.equal(createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex'),backup.checksum);
    assert.equal(backup.tables.agent_runs[0].storage_version,1);
    const run=(await db.query('SELECT * FROM agent_runs WHERE id=$1',[f.id])).rows[0];assert.equal(run.storage_version,2);assert.deepEqual(run.context,f.context);assert.equal(run.status,'waiting_confirmation');
    const entries=(await db.query('SELECT body FROM agent_pi_entries WHERE thread_id=$1 ORDER BY position',[f.thread])).rows.map(row=>JSON.parse(row.body));
    const manager=SessionManager.inMemory(process.cwd(),undefined,entries);
    assert.ok(JSON.stringify(manager.buildSessionContext()).includes('原始完整目标'));
    assert.equal((await db.query('SELECT * FROM agent_pi_pending WHERE run_id=$1',[f.id])).rowCount,1);
    assert.equal((await migrateAgentPi(client,directory)).migrated,0);
    assert.deepEqual((await db.query('SELECT body FROM agent_pi_entries WHERE thread_id=$1 ORDER BY position',[f.thread])).rows.map(row=>JSON.parse(row.body)),entries);
});
test('Pi migration rejects unknown versions and conflicting native history without overwrite',async()=>{
    const f=await fixture();await db.query('UPDATE agent_runs SET storage_version=999 WHERE id=$1',[f.id]);
    await assert.rejects(()=>migrateAgentPi(client,directory),/Unknown storage/);
    assert.equal((await db.query('SELECT storage_version FROM agent_runs WHERE id=$1',[f.id])).rows[0].storage_version,999);
    await db.query('UPDATE agent_runs SET storage_version=1 WHERE id=$1',[f.id]);
    await db.query("INSERT INTO agent_pi_sessions(thread_id,storage_version,signature) VALUES($1,1,'conflict')",[f.thread]);
    await assert.rejects(()=>migrateAgentPi(client,directory),/Conflicting migration/);
    assert.equal((await db.query('SELECT context FROM agent_runs WHERE id=$1',[f.id])).rows[0].context[0].content,'原始完整目标');
    await db.query('DELETE FROM agent_pi_sessions WHERE thread_id=$1',[f.thread]);
    await db.query('UPDATE agent_runs SET storage_version=2 WHERE id=$1',[f.id]);
});
test('Pi migration pauses undispatched runs and never redispatches unknown requests',async()=>{
    const pending=await fixture('queued'),unknown=await fixture('running');
    await db.query("INSERT INTO agent_steps(run_id,step,item_id,status,request) VALUES($1,1,$2,'requesting','{}')",[unknown.id,randomUUID()]);
    await migrateAgentPi(client,directory);
    assert.equal((await db.query('SELECT status FROM agent_runs WHERE id=$1',[pending.id])).rows[0].status,'waiting_input');
    assert.equal((await db.query('SELECT status FROM agent_runs WHERE id=$1',[unknown.id])).rows[0].status,'unknown');
    assert.equal((await db.query('SELECT status FROM agent_steps WHERE run_id=$1',[unknown.id])).rows[0].status,'unknown');
});
