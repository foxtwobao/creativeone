import type pg from "pg";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { transaction } from "../db.js";
import { HttpError } from "../http.js";
import { modelErrorMessage } from "../model-errors.js";
import { inlineStoredFile } from "../storage.js";
import { ensureKey } from "../tokenone.js";
import { findCanvasProject } from "../business.js";
import { readModelPricing } from "../account-pricing.js";
import { readAgentConfig } from "./config.js";
import { creativePiTools,creativePiArgumentErrors,piReadOnlyTools } from "./pi-tools.js";
import { executeTool,refreshSources,ToolParameterError } from "./tools.js";
import { lockRun,saveReceipt,setState,type Run,type Client } from "./state.js";

export const toolFailure=(message:Extract<AgentMessage,{role:"toolResult"}>,error="AGENT_TOOL_FAILED")=>({
    error,
    message:message.content.filter(part=>part.type==="text").map(part=>part.text).join("\n"),
});

// CreativeONE owns tool effects, authorization and receipts. Pi receives only the tool definitions.
export function createCreativeToolset(owner:pg.Client,initial:Run,token:string,signal:AbortSignal){
    const {id,user_id:userId}=initial;
    const tx=<T>(work:(client:Client)=>Promise<T>)=>transaction(work,owner);
    let run=initial;
    const read=async()=>{
        run=await tx(client=>lockRun(client,id,userId,token));
        return run;
    };
    const tools=creativePiTools(async call=>execute(await canonicalCall(call.toolCallId),call.input));
    async function canonicalCall(nativeId:string){
        const planned=(await owner.query("SELECT decision FROM agent_steps WHERE run_id=$1 AND decision->'calls' @> $2::jsonb ORDER BY step DESC LIMIT 1",[id,JSON.stringify([{nativeId}])])).rows[0];
        const call=planned?.decision.calls.find((call:any)=>call.nativeId===nativeId);
        if(!call)throw new HttpError(409,"AGENT_INVALID_MODEL_RESPONSE");
        return call;
    }
    const argumentReceipt=(call:any,calls=[call])=>({
        error:"AGENT_INVALID_TOOL_ARGUMENTS",
        message:call.argumentsError
            ? "工具参数不是合法的 JSON 对象，本次决定未执行；请检查字符串双引号、逗号和括号。"
            : "本次决定未执行，请根据字段问题修正。",
        details:creativePiArgumentErrors(calls,tools).find(error=>error.callId===call.toolCallId)
            || {message:"同一决定含无效参数，当前调用也未执行。"},
    });
    async function resultContent(result:any){
        const content:any[]=[{type:"text",text:JSON.stringify(result)}];
        for(const url of result?.images||[]){
            const data=await inlineStoredFile(userId,url),match=/^data:([^;]+);base64,(.*)$/s.exec(data);
            if(match)content.push({type:"image",mimeType:match[1],data:match[2]});
        }
        return content;
    }
    async function execute(call:any,input=call.input){
        if(piReadOnlyTools.has(call.toolName))call={...call,input};
        signal.throwIfAborted();
        await read();
        if(!(await readAgentConfig(owner)).enabled){
            await tx(client=>setState(client,run,"queued"));
            throw new HttpError(503,"AGENT_DISABLED");
        }
        const prior=(await owner.query("SELECT name,input,result FROM agent_tool_receipts WHERE run_id=$1 AND call_id=$2",[id,call.toolCallId])).rows[0];
        if(prior){
            if(prior.name!==call.toolName||!isDeepStrictEqual(prior.input,call.input))throw new HttpError(409,"AGENT_OPERATION_CONFLICT");
            return {content:await resultContent(prior.result),details:prior.result};
        }
        const external:{pricing?:unknown;groupId?:string}={};
        const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(run.model_config.limits.requestTimeoutMs)]);
        if(["get_model_capabilities","submit_generation","workbench_image_generate","workbench_video_generate"].includes(call.toolName))external.pricing=await readModelPricing(id,requestSignal).catch(()=>undefined);
        if(["submit_generation","workbench_image_generate","workbench_video_generate"].includes(call.toolName)&&run.wait?.approved){
            const user=(await owner.query("SELECT * FROM users WHERE id=$1",[userId])).rows[0];
            external.groupId=(await ensureKey(user,id,{signal:requestSignal})).group_id;
        }
        let result:any;
        try{
            result=await tx(async client=>{
                run=await lockRun(client,id,userId,token);
                const value=await executeTool(client,run,call,external);
                if(value===undefined){
                    await client.query("INSERT INTO agent_pi_pending(run_id,call_id,name,input) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[id,call.toolCallId,call.toolName,JSON.stringify(call.input)]);
                    const state=(await client.query("SELECT status,wait FROM agent_runs WHERE id=$1",[id])).rows[0];
                    return {operationId:call.toolCallId,status:state.status,wait:state.wait};
                }
                await saveReceipt(client,run,call,value);
                return value;
            });
        }catch(error){
            const code=error instanceof HttpError?error.code:"AGENT_TOOL_FAILED";
            if(["AGENT_EXECUTION_CHANGED","AGENT_STORAGE_VERSION","AGENT_OPERATION_CONFLICT"].includes(code))throw error;
            if(["AGENT_SOURCE_CHANGED","PROJECT_REVISION_CONFLICT","CANVAS_NODE_NOT_FOUND","AGENT_CONFIRMATION_CHANGED","AGENT_CANVAS_NOT_READ"].includes(code)){
                await tx(async client=>{
                    run=await lockRun(client,id,userId,token);
                    await refreshSources(client,run,await findCanvasProject(userId,run.project_id,client,true),true);
                    await setState(client,run,"queued");
                });
                result={error:code,message:"来源已同步，当前旧决定未执行，请基于新的业务事件重新规划。"};
            }else{
                result={
                    error:code,
                    message:error instanceof ToolParameterError?error.explanation
                        : modelErrorMessage(code,error instanceof HttpError?error.upstreamError:undefined)||`工具执行未完成（${code}）。`,
                };
                await tx(async client=>{
                    run=await lockRun(client,id,userId,token);
                    await saveReceipt(client,run,call,result);
                });
            }
        }
        const status=(await owner.query("SELECT status FROM agent_runs WHERE id=$1",[id])).rows[0].status;
        return {
            content:await resultContent(result),
            details:result,
            ...status!=="running"?{terminate:true}:{},
        };
    }
    async function prepareResult(message:Extract<AgentMessage,{role:"toolResult"}>,{waiting,invalid}:{waiting:boolean;invalid?:string}){
        if(!message.isError)return;
        const call=await canonicalCall(message.toolCallId);
        const receipt=invalid?argumentReceipt(call):toolFailure(message,waiting?"AGENT_TOOL_DEFERRED":"AGENT_TOOL_FAILED");
        const sdkError=structuredClone(message.content);
        message.content=[{type:"text",text:JSON.stringify(receipt)}];
        message.details={receipt,sdkError};
    }
    return {tools,execute,canonicalCall,argumentReceipt,prepareResult};
}
