import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { piSessionStore } from "./agent/pi-session-store.js";
import type { PiSnapshot } from "./agent/pi-session.js";

const enabled=Boolean(process.env.TEST_DATABASE_URL);
let pool:pg.Pool;
before(async()=>{
    if(!enabled)return;
    assert.match(new URL(process.env.TEST_DATABASE_URL!).pathname,/^\/creativeone_pi_runtime_[a-f0-9]{32}_test$/);
    pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
    await pool.query("CREATE TABLE agent_threads(id uuid PRIMARY KEY,user_id uuid,active_run_id uuid); CREATE TABLE agent_runs(id uuid PRIMARY KEY,thread_id uuid REFERENCES agent_threads(id),user_id uuid,execution_token uuid,status text)");
    const schema=await readFile(new URL("../schema.sql",import.meta.url),"utf8");
    await pool.query(schema.slice(schema.indexOf("-- Pi's original JSON"),schema.indexOf("CREATE TABLE IF NOT EXISTS agent_tool_receipts")));
});
after(async()=>{await pool?.end();});
async function fixture(){
    const user=randomUUID(),thread=randomUUID(),turn=randomUUID(),token=randomUUID();
    await pool.query("INSERT INTO agent_threads VALUES($1,$2,$3)",[thread,user,turn]);await pool.query("INSERT INTO agent_runs VALUES($1,$2,$3,$4,'running')",[turn,thread,user,token]);
    const transaction=async<T>(work:(client:Pick<pg.PoolClient,"query">)=>Promise<T>)=>{
        const client=await pool.connect();
        try{await client.query("BEGIN");const result=await work(client);await client.query("COMMIT");return result;}
        catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    };
    const snapshot:PiSnapshot={version:1,signature:"rules-and-tools-v1",entries:[{type:"session",version:CURRENT_SESSION_VERSION,id:randomUUID(),timestamp:new Date().toISOString(),cwd:process.cwd()}]};
    return {user,thread,turn,token,snapshot,transaction,store:piSessionStore(user,thread,turn,token,pool.query.bind(pool),transaction)};
}
test("Pi repository round-trips original entry text and rejects stale appends",{skip:!enabled},async()=>{
    const f=await fixture();await f.store.append(f.snapshot,0);
    f.snapshot.entries.push({type:"message",id:"message-one",parentId:null,timestamp:new Date().toISOString(),message:{role:"user",content:[{type:"text",text:'{"z":1,"a":2}'}],timestamp:Date.now()}});
    await f.store.append(f.snapshot,1);
    assert.equal(JSON.stringify(await f.store.load()),JSON.stringify(f.snapshot));
    await assert.rejects(()=>f.store.append(f.snapshot,1),/AGENT_EXECUTION_CHANGED/);
});
test("Pi repository checks account, thread and turn ownership",{skip:!enabled},async()=>{
    const f=await fixture();await f.store.append(f.snapshot,0);
    const foreign=piSessionStore(randomUUID(),f.thread,f.turn,f.token,pool.query.bind(pool),f.transaction);
    assert.equal(await foreign.load(),undefined);await assert.rejects(()=>foreign.append(f.snapshot,1),/AGENT_EXECUTION_CHANGED/);
    const wrongTurn=piSessionStore(f.user,f.thread,randomUUID(),f.token,pool.query.bind(pool),f.transaction);
    await assert.rejects(()=>wrongTurn.append(f.snapshot,1),/AGENT_EXECUTION_CHANGED/);
    const another=await fixture();
    await pool.query("UPDATE agent_pi_entries SET turn_id=$2 WHERE thread_id=$1",[f.thread,another.turn]);
    await assert.rejects(()=>f.store.load(),/AGENT_CONTEXT_CHECKPOINT_INVALID/);
    await pool.query("UPDATE agent_pi_entries SET turn_id=$2 WHERE thread_id=$1",[f.thread,f.turn]);
    await pool.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1",[f.turn]);
    await assert.rejects(()=>f.store.append(f.snapshot,1),/AGENT_EXECUTION_CHANGED/);
});
test("Pi repository serializes concurrent owners and commits only one append",{skip:!enabled},async()=>{
    const f=await fixture();const attempts=await Promise.allSettled([f.store.append(f.snapshot,0),f.store.append(f.snapshot,0)]);
    assert.equal(attempts.filter(result=>result.status==="fulfilled").length,1);
    assert.equal((await pool.query("SELECT * FROM agent_pi_entries WHERE thread_id=$1",[f.thread])).rowCount,1);
});
test("Pi repository rolls back the manifest and all entries together",{skip:!enabled},async()=>{
    const f=await fixture();
    const failing=piSessionStore(f.user,f.thread,f.turn,f.token,pool.query.bind(pool),work=>f.transaction(client=>work({query:async(...args:any[])=>{
        if(String(args[0]).startsWith("INSERT INTO agent_pi_entries"))throw new Error("ENTRY_WRITE_FAILED");
        return (client.query as any)(...args);
    }})));
    await assert.rejects(()=>failing.append(f.snapshot,0),/ENTRY_WRITE_FAILED/);
    assert.equal((await pool.query("SELECT * FROM agent_pi_sessions WHERE thread_id=$1",[f.thread])).rowCount,0);
    assert.equal(await f.store.load(),undefined);
});
test("Pi repository refuses corrupt or unknown manifests without overwriting them",{skip:!enabled},async()=>{
    const f=await fixture();await f.store.append(f.snapshot,0);
    await pool.query("UPDATE agent_pi_sessions SET storage_version=999 WHERE thread_id=$1",[f.thread]);
    await assert.rejects(()=>f.store.load(),/AGENT_STORAGE_VERSION/);
    await assert.rejects(()=>f.store.append(f.snapshot,1),/AGENT_STORAGE_VERSION/);
    assert.equal((await pool.query("SELECT storage_version FROM agent_pi_sessions WHERE thread_id=$1",[f.thread])).rows[0].storage_version,999);
});
