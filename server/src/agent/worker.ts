import pg from "pg";
import { agentSettingsDefaults } from "../../../shared/agent-settings.js";
import { randomUUID } from "node:crypto";
import { db, transaction } from "../db.js";
import { env } from "../config.js";
import { findCanvasProject } from "../business.js";
import { HttpError } from "../http.js";
import { readAgentConfig,readAgentSettings, AGENT_STORAGE_VERSION } from "./config.js";
import { refreshSources, taskResults } from "./tools.js";
import { authorizationPause, lockRun, setState, item, saveReceipt, type Run, type Client } from "./state.js";

const active=new Map<string,AbortController>();
export const cancelActiveRun=(id:string) => active.get(id)?.abort();
export async function settleTaskWait(client:Client,run:Run) {
    const tasks=await taskResults(client,run.user_id,run.wait.taskIds);
    if (tasks.some(task => !["succeeded","pending","running"].includes(task.status))) {
        await setState(client,run,"waiting_input",{...run.wait,type:"task_failure",tasks});
        await item(client,run,"system","部分生成任务失败或结果未知；已保留成果，不会自动补生成。",{tasks});
        return;
    }
    if (tasks.some(task => task.status !== "succeeded")) return;
    await resolveTaskWait(client,run,tasks);
}
export async function resolveTaskWait(client:Client,run:Run,tasks:unknown[]) {
    const excludedTaskIds=run.wait.taskIds.filter((id:string) => !tasks.some((task:any) => task.id === id));
    await client.query("UPDATE agent_runs SET excluded_tasks=$2 WHERE id=$1",[run.id,JSON.stringify([...new Set([...run.excluded_tasks,...excludedTaskIds])])]);
    if (run.wait.callId) {
        const step=(await client.query("SELECT * FROM agent_steps WHERE run_id=$1 AND status='decided' ORDER BY step DESC LIMIT 1",[run.id])).rows[0];
        const call=step?.decision.calls.find((call:any) => call.toolCallId === run.wait.callId);
        if (!call) throw new HttpError(409,"AGENT_WAIT_CHANGED");
        await saveReceipt(client,run,call,{tasks,excludedTaskIds:run.wait.taskIds.filter((id:string) => !tasks.some((task:any) => task.id === id))});
    } else await item(client,run,"system","后台任务已结束，请读取真实结果并反馈。",{tasks});
    await setState(client,run,"queued");
}

export async function executeAgentRun(id:string) {
    const agentConfig=await readAgentConfig();
    if (!agentConfig.enabled || active.has(id) || active.size >= agentConfig.globalConcurrency) return;
    const controller=new AbortController(),owner=new pg.Client({connectionString:env.DATABASE_URL,application_name:"creativeone-agent"});
    active.set(id,controller);
    let disconnected=false;
    owner.on("error",() => {disconnected=true;controller.abort();});
    owner.on("end",() => {disconnected=true;controller.abort();});
    const token=randomUUID();
    try {
        await owner.connect();
        const lock=async (key:string) => (await owner.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",[key])).rows[0].ok;
        if (!await lock(`agent-run:${id}`)) return;
        const initial=(await owner.query("SELECT user_id FROM agent_runs WHERE id=$1 AND status IN ('queued','running')",[id])).rows[0];
        if (!initial) return;
        const claimed=await transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agent-dispatch',0))");
            const config=await readAgentConfig(client);
            const busy=(await client.query(`SELECT count(*) AS total,count(*) FILTER(WHERE r.user_id=$1) AS account FROM agent_runs r WHERE r.status='running' AND r.id<>$2 AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.classid::bigint=((hashtextextended('agent-run:'||r.id::text,0)>>32)&4294967295) AND l.objid::bigint=(hashtextextended('agent-run:'||r.id::text,0)&4294967295))`,[initial.user_id,id])).rows[0];
            if(!config.enabled || Number(busy.total)>=config.globalConcurrency || Number(busy.account)>=config.accountConcurrency)return false;
            const run=await lockRun(client,id,initial.user_id);
            const thread=(await client.query("SELECT active_run_id FROM agent_threads WHERE id=$1",[run.thread_id])).rows[0];
            if (thread.active_run_id !== id || !["queued","running"].includes(run.status)) return false;
            const requesting=(await client.query("SELECT step FROM agent_steps WHERE run_id=$1 AND status='requesting'",[id])).rows[0];
            if (requesting) {
                await client.query("UPDATE agent_steps SET status='unknown' WHERE run_id=$1 AND step=$2",[id,requesting.step]);
                await setState(client,run,"unknown",{type:"unknown_model",question:"上次模型请求可能已计费，但完整响应未保存。不会自动重发；请结束此运行后明确发起新尝试。"},"AGENT_MODEL_UNKNOWN");
                await item(client,run,"system","模型请求结果未知，已停止自动执行，未重新计费请求。");
                return false;
            }
            await client.query("UPDATE agent_runs SET status='running',execution_token=$2,updated_at=now() WHERE id=$1",[id,token]);
            return true;
        },owner);
        if (!claimed) return;
        const {executePiRun}=await import("./pi-runtime.js");
        await executePiRun(owner,id,initial.user_id,token,controller.signal);
    } catch (error) {
        if (!disconnected) await transaction(async client => {
            const row=(await client.query("SELECT user_id FROM agent_runs WHERE id=$1",[id])).rows[0];
            if (!row) return;
            const current=(await client.query("SELECT status,execution_token FROM agent_runs WHERE id=$1",[id])).rows[0];
            if(current.status!=="running"||current.execution_token!==token)return;
            const run=await lockRun(client,id,row.user_id,token);
            const code=error instanceof HttpError ? error.code : "AGENT_EXECUTION_FAILED";
            if (["AGENT_OPERATION_CONFLICT","AGENT_CONTEXT_CHECKPOINT_INVALID"].includes(code)) {await setState(client,run,"failed",null,code);return;}
            if(["AGENT_SOURCE_CHANGED","CANVAS_NODE_NOT_FOUND"].includes(code)&&await refreshSources(client,run,await findCanvasProject(run.user_id,run.project_id,client,true))){await setState(client,run,"queued");return;}
            await setState(client,run,"waiting_input",code === "AGENT_SOURCE_CHANGED" || code === "CANVAS_NODE_NOT_FOUND" ? {type:"conflict",question:"画布来源已变化，已有成果保留。请使用当前画布重新决策。",code} : authorizationPause(code));
        },owner).catch(() => undefined);
    } finally {
        if(!disconnected)await owner.query("UPDATE agent_runs SET execution_token=NULL WHERE id=$1 AND execution_token=$2",[id,token]).catch(()=>undefined);
        active.delete(id);
        await owner.end().catch(() => undefined); // Releases every session lock, including on cancellation.
    }
}
export async function scanAgentRuns() {
    const agentConfig=await readAgentConfig();
    if (!agentConfig.enabled) return;
    for (const [id,controller] of active) {
        const row=(await db.query("SELECT status FROM agent_runs WHERE id=$1",[id])).rows[0];
        if (!row || row.status !== "running") controller.abort();
    }
    const waits=(await db.query("SELECT id,user_id FROM agent_runs WHERE status='waiting_tasks' ORDER BY created_at")).rows;
    for (const wait of waits) await transaction(async client => {
        const run=await lockRun(client,wait.id,wait.user_id);
        if (run.status === "waiting_tasks") await settleTaskWait(client,run);
    }).catch(() => undefined);
    const rows=(await db.query("SELECT id FROM agent_runs WHERE status IN ('queued','running') AND storage_version=$1 ORDER BY created_at",[AGENT_STORAGE_VERSION])).rows;
    for (const {id} of rows) {
        if (active.size >= agentConfig.globalConcurrency) break;
        if (!active.has(id)) void executeAgentRun(id).catch(()=>console.error(JSON.stringify({code:"AGENT_EXECUTION_FAILED",runId:id})));
    }
}
export function startAgentWorker() {
    let timer:ReturnType<typeof setTimeout>,stopped=false;
    const tick=async()=>{
        let delay=agentSettingsDefaults.scanIntervalMs;
        try{await scanAgentRuns();delay=(await readAgentSettings()).scanIntervalMs;}catch{console.error(JSON.stringify({code:"AGENT_SCAN_FAILED"}));}
        if(!stopped)timer=setTimeout(()=>void tick(),delay);
    };
    void tick();return()=>{stopped=true;clearTimeout(timer);};
}
