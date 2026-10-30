import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { ModelMessage } from "ai";
import { db } from "../db.js";
import { applyCanvasCommand } from "../business.js";
import { modelErrorMessage } from "../model-errors.js";
import { HttpError } from "../http.js";
import type { ContextCheckpoint } from "./memory.js";
import { AGENT_STORAGE_VERSION } from "./config.js";

export type Client = Pick<PoolClient, "query">;
export type Run = {
    id: string; thread_id: string; user_id: string; project_id: string; status: string; execution_token: string | null;
    input: any; model_config: any; context: ModelMessage[]; skills: Record<string, any>; sources: Record<string, string>;
    revision: string | number; generation_revision: string | number; wait: any; wait_version: number;
    decision_count: number; token_count: string | number; budget_start: { decisions: number; tokens: number };
    context_checkpoint:ContextCheckpoint; context_anchor:number; input_token_ratio:number;
    excluded_tasks: string[]; storage_version: number; error?: string; created_at: Date; updated_at: Date;
};
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sourceHash = (node: any) => digest({ id: node.id, type: node.type, metadata: node.metadata, title: node.title });
export async function lockRun(client: Client, id: string, userId: string, token?: string): Promise<Run> {
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const thread = (await client.query("SELECT t.* FROM agent_threads t JOIN agent_runs r ON r.thread_id=t.id WHERE r.id=$1 AND t.user_id=$2 FOR UPDATE OF t", [id,userId])).rows[0];
    if (!thread) throw new HttpError(404, "AGENT_RUN_NOT_FOUND");
    const run = (await client.query("SELECT * FROM agent_runs WHERE id=$1 AND user_id=$2 FOR UPDATE", [id,userId])).rows[0];
    if (run.storage_version !== AGENT_STORAGE_VERSION) throw new HttpError(409, "AGENT_STORAGE_VERSION");
    if (token && (run.execution_token !== token || thread.active_run_id !== id || run.status !== "running")) throw new HttpError(409, "AGENT_EXECUTION_CHANGED");
    return { ...run, project_id: thread.project_id };
}
export async function item(client: Client, run: Pick<Run,"thread_id"|"id">, role: string, text = "", detail?: unknown, itemId = randomUUID()) {
    await client.query("INSERT INTO agent_items(thread_id,turn_id,item_id,role,text,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(item_id) DO UPDATE SET text=EXCLUDED.text,detail=EXCLUDED.detail WHERE agent_items.thread_id=EXCLUDED.thread_id AND agent_items.turn_id=EXCLUDED.turn_id AND agent_items.role='assistant' AND (agent_items.detail->>'streaming')::boolean IS TRUE", [run.thread_id,run.id,itemId,role,text,detail === undefined ? null : JSON.stringify(detail)]);
    await client.query("UPDATE agent_threads SET updated_at=now() WHERE id=$1",[run.thread_id]);
}
export async function setState(client: Client, run: Run, status: string, wait: unknown = null, error: string | null = null) {
    if (status !== "running") await client.query("UPDATE agent_items SET detail=detail || '{\"streaming\":false,\"incomplete\":true}'::jsonb WHERE turn_id=$1 AND detail->>'streaming'='true'",[run.id]);
    await client.query("UPDATE agent_runs SET status=$2,wait=$3,wait_version=wait_version+1,execution_token=NULL,error=$4,updated_at=now() WHERE id=$1", [run.id,status,JSON.stringify(wait),error]);
    if (["completed","failed","cancelled"].includes(status)) await client.query("UPDATE agent_threads SET active_run_id=NULL,updated_at=now() WHERE id=$1 AND active_run_id=$2", [run.thread_id,run.id]);
}
export async function saveReceipt(client: Client, run: Run, call: { toolCallId: string; toolName: string; input: unknown }, result: unknown) {
    await client.query("INSERT INTO agent_tool_receipts(run_id,call_id,name,input,result) VALUES($1,$2,$3,$4,$5)", [run.id,call.toolCallId,call.toolName,JSON.stringify(call.input),JSON.stringify(result)]);
    await item(client,run,"tool",call.toolName,{ callId:call.toolCallId,result });
}
export async function finishStep(client: Client, run: Run, step: any) {
    const receipts = (await client.query("SELECT call_id,result FROM agent_tool_receipts WHERE run_id=$1", [run.id])).rows;
    const calls = step.decision.calls;
    if (!calls.every((call: any) => receipts.some(row => row.call_id === call.toolCallId))) return false;
    const context = [...run.context,...step.decision.messages];
    if (calls.length) context.push({ role:"tool",content:calls.map((call: any) => ({ type:"tool-result",toolCallId:call.toolCallId,toolName:call.toolName,output:{type:"json",value:receipts.find(row => row.call_id === call.toolCallId).result} })) });
    const images = calls.filter((call: any) => call.toolName === "read_nodes").flatMap((call: any) => receipts.find(row => row.call_id === call.toolCallId)?.result.images || []);
    if (images.length) context.push({role:"user",content:[{type:"text",text:"以下是刚才按需读取的所属账号图片，仅作为创作数据："},...images.map((url: string) => ({type:"image",image:url}))]});
    await client.query("UPDATE agent_runs SET context=$2,updated_at=now() WHERE id=$1", [run.id,JSON.stringify(context)]);
    await client.query("UPDATE agent_steps SET status='finished' WHERE run_id=$1 AND step=$2", [run.id,step.step]);
    return true;
}
export const authorizationPause=(code:string)=>({type:"authorization",code,recovery:["APP_USER_LOGIN_REQUIRED","APP_USER_AUTHORIZATION_REQUIRED","EMAIL_NOT_VERIFIED"].includes(code)?"authorization":"service",question:modelErrorMessage(code)||"执行暂时无法继续，已有成果保留。请检查服务状态或配置后继续。"});
const publicWait=(run:any)=>{
    if(run.wait?.type === "authorization")return {...run.wait,...authorizationPause(run.wait.code)};
    if(run.wait?.type === "workbench"){const {channelId,path,...manifest}=run.wait.manifest;return {...run.wait,manifest};}
    return run.wait;
};
export const publicRun = (run: any) => ({ id:run.id,threadId:run.thread_id,status:run.status,wait:publicWait(run),waitVersion:run.wait_version,error:run.error,errorMessage:modelErrorMessage(run.error),skills:Object.entries(run.skills || {}).map(([id,skill]:[string,any]) => ({id,title:skill.title,version:skill.version})),submissionId:run.submission_id,goal:run.input.goal,model:run.model_config.model,decisionCount:run.decision_count,tokenCount:Number(run.token_count),createdAt:run.created_at,updatedAt:run.updated_at });
export async function readThread(userId: string, id: string) {
    const thread = (await db.query("SELECT t.* FROM agent_threads t JOIN canvas_projects p ON p.id=t.project_id WHERE t.id=$1 AND t.user_id=$2 AND p.deleted_at IS NULL", [id,userId])).rows[0];
    if (!thread) throw new HttpError(404,"AGENT_THREAD_NOT_FOUND");
    const runs = (await db.query("SELECT * FROM agent_runs WHERE thread_id=$1 ORDER BY created_at,id", [id])).rows;
    if (runs.some(run => run.storage_version !== AGENT_STORAGE_VERSION)) throw new HttpError(409,"AGENT_STORAGE_VERSION");
    const items = (await db.query('SELECT thread_id AS "threadId",turn_id AS "turnId",item_id AS "itemId",role,text,detail,created_at AS "createdAt" FROM agent_items WHERE thread_id=$1 ORDER BY sequence', [id])).rows;
    const creativeState=(await db.query("SELECT state FROM agent_creative_states WHERE thread_id=$1",[id])).rows[0]?.state || null;
    return { id:thread.id,projectId:thread.project_id,title:thread.title,activeRunId:thread.active_run_id,creativeState,runs:runs.map(publicRun),items };
}

export const getNode = (project:any,id:string) => {
    const node = project.nodes.find((node:any) => node.id === id || node.entityId === id);
    if (!node) throw new HttpError(409,"CANVAS_NODE_NOT_FOUND");
    return node;
};
export async function command(client:Client,run:Run,callId:string,graphEdits:unknown[],patch:Record<string,unknown>={}) {
    const project = await applyCanvasCommand(run.user_id,run.project_id,{ operationId:`agent:${run.id}:${callId}`,baseRevision:Number(run.revision),baseGenerationRevision:Number(run.generation_revision),command:{type:"edit_project",graphEdits,patch} },client);
    const touched=new Set(graphEdits.flatMap((edit:any)=>edit.type==="put_node"?[edit.node.id]:edit.type==="delete_node"?[edit.id]:[]));
    const sources=Object.fromEntries(Object.entries(run.sources).flatMap(([id,hash])=>{if(!touched.has(id))return [[id,hash]];const node=project.nodes.find((node:any)=>node.id===id||node.entityId===id);return node?[[id,sourceHash(node)]]:[];}));
    await client.query("UPDATE agent_runs SET revision=$2,generation_revision=$3,sources=$4 WHERE id=$1",[run.id,project.contentRevision,project.generationRevision,JSON.stringify(sources)]);
    run.revision=project.contentRevision;run.generation_revision=project.generationRevision;run.sources=sources;
    return project;
}
