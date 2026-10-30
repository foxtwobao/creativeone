import type pg from "pg";
import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { delay,retryWithExponentialBackoff } from "@ai-sdk/provider-utils";
import { transaction } from "../db.js";
import { HttpError } from "../http.js";
import { ensureKey,modelProvider } from "../tokenone.js";
import { findCanvasProject } from "../business.js";
import { readAgentConfig } from "./config.js";
import { agentEvents } from "./events.js";
import { agentDecision,expandAgentImages } from "./model.js";
import { assertSources } from "./tools.js";
import { contextCheckpoint,estimatedInputTokens,isContextRejection } from "./memory.js";
import { lockRun,setState,item,type Run } from "./state.js";

class PausedRequest extends Error {}
export const retryableAgentError=(error:unknown)=>APICallError.isInstance(error)
    ? error.isRetryable && (error.statusCode===undefined || [408,409,429].includes(error.statusCode) || error.statusCode>=500)
    : error instanceof TypeError || error instanceof Error && error.message==="AGENT_STREAM_INCOMPLETE";
export function agentRetryDelay(error:unknown,fallback:number){
    const headers=APICallError.isInstance(error)?error.responseHeaders:undefined,ms=headers?.["retry-after-ms"],value=headers?.["retry-after"];
    const parsed=ms!==undefined?Number(ms):value!==undefined?(Number.isFinite(Number(value))?Number(value)*1000:Date.parse(value)-Date.now()):NaN;
    return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;
}

// Each transport attempt gets its own durable step. SDK retries stay disabled.
export async function requestAgentModel(owner:pg.Client,run:Run,request:any,token:string,cancel:AbortSignal):Promise<boolean>{
    const id=run.id,maxRetries=run.model_config.limits.modelRetries??0,previous=request.retry;
    const deadline=previous?.deadline??Date.now()+run.model_config.limits.requestTimeoutMs;
    let attempts=previous?.attempt??0,retryAt=previous?.retryAt??0,step:{step:number;itemId:string}|undefined,lastError:unknown;
    const expire=async()=>{
        await transaction(async client=>{run=await lockRun(client,id,run.user_id,token);await client.query("UPDATE agent_steps SET request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND request#>>'{retry,pending}'='true'",[id]);await setState(client,run,previous?.known===false?"unknown":"failed",previous?.known===false?{type:"unknown_model",question:"重试等待已结束，模型结果不明；已有记录保留，请结束本轮后明确发起新尝试。"}:null,"AGENT_MODEL_RETRY_TIMEOUT");},owner);return false;
    };
    if(deadline<=Date.now())return expire();
    const signal=AbortSignal.any([cancel,AbortSignal.timeout(deadline-Date.now())]);
    const retry=retryWithExponentialBackoff({maxRetries:Math.max(0,maxRetries-attempts),initialDelayInMs:2000*2**attempts,abortSignal:signal,
        createRetryError:({errors})=>errors.at(-1),getDelayInMs:()=>Math.max(0,Math.min(retryAt,deadline)-Date.now()),
        shouldRetry:async error=>{
            if(error!==lastError||signal.aborted||!retryableAgentError(error))return false;
            const wait=agentRetryDelay(error,2000*2**(attempts-1));retryAt=Date.now()+wait;
            const proceed=await transaction(async client=>{
                run=await lockRun(client,id,run.user_id,token);
                const withinBudget=run.decision_count-run.budget_start.decisions<run.model_config.limits.decisionBudget;
                await client.query("UPDATE agent_steps SET status='finished',request=jsonb_set(request,'{retry}',$3) WHERE run_id=$1 AND step=$2",[id,step!.step,JSON.stringify({attempt:attempts,deadline,retryAt,pending:withinBudget,known:APICallError.isInstance(error)&&error.statusCode!==undefined})]);
                if(!withinBudget){await setState(client,run,"waiting_input",{type:"budget",question:`本轮已达到 ${run.model_config.limits.decisionBudget} 次模型调用，自动重试也计入次数；已有成果保留，请确认后继续。`});return false;}
                await item(client,run,"system",`文本推理暂时失败，等待后自动重试 ${attempts}/${maxRetries}；每次请求计入调用预算，失败尝试也可能计费。`,{kind:"model_retry",attempt:attempts,maxRetries,delayMs:wait});
                return true;
            },owner);if(!proceed)throw new PausedRequest();return true;
        }});
    try{
        if(retryAt>Date.now())await delay(Math.max(0,Math.min(retryAt,deadline)-Date.now()),{abortSignal:signal});
        const result=await retry(async()=>{
            signal.throwIfAborted();
            if(Date.now()>=deadline)throw new DOMException("Agent request deadline exceeded","TimeoutError");
            const config=await readAgentConfig(owner);if(!config.enabled)throw new PausedRequest();
            if(run.model_config.provider!==modelProvider||!config.verifiedModels.some(entry=>entry.model===run.model_config.model))throw new HttpError(403,"AGENT_MODEL_UNAVAILABLE");
            if(!(await owner.query("SELECT id FROM channels WHERE id=$1 AND enabled AND capability='text' AND models ? $2",[run.model_config.channelId,run.model_config.model])).rowCount)throw new HttpError(403,"AGENT_MODEL_UNAVAILABLE");
            const user=(await owner.query("SELECT * FROM users WHERE id=$1",[run.user_id])).rows[0],key=await ensureKey(user,id,{signal});
            const messages=request.kind==="compaction"?request.messages:await expandAgentImages(run.user_id,request.messages,run.model_config.imageInput);
            step=await transaction(async client=>{
                run=await lockRun(client,id,run.user_id,token);const latest=await readAgentConfig(client);if(!latest.enabled)throw new PausedRequest();
                if(!latest.verifiedModels.some(entry=>entry.model===run.model_config.model))throw new HttpError(403,"AGENT_MODEL_UNAVAILABLE");
                if(run.decision_count-run.budget_start.decisions>=run.model_config.limits.decisionBudget){
                    await client.query("UPDATE agent_steps SET request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND request#>>'{retry,pending}'='true'",[id]);
                    await setState(client,run,"waiting_input",{type:"budget",question:`本轮已达到 ${run.model_config.limits.decisionBudget} 次模型调用，自动重试也计入次数。已有成果保留，请确认后继续。`});return;
                }
                await assertSources(run,await findCanvasProject(run.user_id,run.project_id,client));
                const step=run.decision_count+1,itemId=randomUUID();attempts++;
                await client.query("UPDATE agent_steps SET request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND request#>>'{retry,pending}'='true'",[id]);
                await client.query("INSERT INTO agent_steps(run_id,step,item_id,status,request,kind) VALUES($1,$2,$3,'requesting',$4,$5)",[id,step,itemId,JSON.stringify({...request,retry:{attempt:attempts,deadline}}),request.kind]);
                await client.query("UPDATE agent_runs SET decision_count=$2 WHERE id=$1",[id,step]);
                if(request.kind==="compaction"){await client.query("UPDATE agent_runs SET context_checkpoint=jsonb_set(context_checkpoint,'{recovery}','\"required\"') WHERE id=$1",[id]);await item(client,run,"system","正在压缩历史上下文，完整历史保留；摘要推理计入本轮预算。",{kind:"compaction"},itemId);}
                return {step,itemId};
            },owner);
            if(!step)throw new PausedRequest();
            try{return await agentDecision(run.model_config.model,key.key,request.system,messages,run.model_config.limits,signal,request.kind==="compaction"?"summary":"decision",request.kind!=="decision"?undefined:async text=>{
                const detail={step:step!.step,streaming:true};
                const updated=await owner.query("INSERT INTO agent_items(thread_id,turn_id,item_id,role,text,detail) SELECT thread_id,id,$2,'assistant',$3,$4 FROM agent_runs WHERE id=$1 AND execution_token=$5 AND status='running' ON CONFLICT(item_id) DO UPDATE SET text=EXCLUDED.text WHERE agent_items.thread_id=EXCLUDED.thread_id AND agent_items.turn_id=EXCLUDED.turn_id AND agent_items.detail->>'streaming'='true' RETURNING item_id",[id,step!.itemId,text,JSON.stringify(detail),token]);
                if(updated.rowCount){agentEvents.emit(run.thread_id,{threadId:run.thread_id,turnId:id,itemId:step!.itemId,role:"assistant",text,detail});await owner.query("SELECT pg_notify('creativeone_agent_items',$1)",[JSON.stringify({threadId:run.thread_id,turnId:id,itemId:step!.itemId})]);}
            });}catch(error){
                lastError=error;
                await transaction(async client=>{await lockRun(client,id,run.user_id,token);await client.query("UPDATE agent_steps SET decision=$3 WHERE run_id=$1 AND step=$2",[id,step!.step,JSON.stringify({invalid:true,status:APICallError.isInstance(error)?error.statusCode:undefined,body:APICallError.isInstance(error)?error.responseBody:undefined,error:error instanceof Error?error.name:"Error"})]);await client.query("UPDATE agent_items SET detail=detail || '{\"streaming\":false,\"incomplete\":true}'::jsonb WHERE turn_id=$1 AND item_id=$2 AND detail->>'streaming'='true'",[id,step!.itemId]);},owner);
                throw error;
            }
        });
        await transaction(async client=>{
            run=await lockRun(client,id,run.user_id,token);
            await client.query("UPDATE agent_steps SET status='decided',decision=$3,usage=$4 WHERE run_id=$1 AND step=$2",[id,step!.step,JSON.stringify(result.decision),JSON.stringify(result.usage)]);
            await client.query("UPDATE agent_runs SET token_count=token_count+$2 WHERE id=$1",[id,result.usage.totalTokens||0]);
            if(request.kind==="decision"){
                const estimated=estimatedInputTokens(request.system,request.messages,1);
                if(estimated&&result.usage.inputTokens)await client.query("UPDATE agent_runs SET input_token_ratio=GREATEST(input_token_ratio,$2) WHERE id=$1",[id,result.usage.inputTokens/estimated]);
                await client.query("UPDATE agent_runs SET context_checkpoint=jsonb_set(context_checkpoint,'{recovery}','null') WHERE id=$1",[id]);
                await item(client,run,"assistant",result.decision.text,{step:step!.step,tools:result.decision.calls.map(call=>({name:call.toolName,callId:call.toolCallId})),usage:result.usage,argumentErrors:result.decision.argumentErrors},step!.itemId);
                if(!result.decision.valid){if(result.decision.errorCode==="AGENT_INVALID_TOOL_ARGUMENTS")await setState(client,run,"waiting_input",{type:"tool_arguments",question:"模型的工具参数不符合当前定义，本次决定均未执行；之前完成的节点保留。可以修正参数并继续，这会再次请求推理模型。",errors:result.decision.argumentErrors},result.decision.errorCode);else await setState(client,run,"failed",null,result.decision.errorCode);}
            }
        },owner);
        return result.decision.valid||request.kind==="compaction";
    }catch(error){
        if(error instanceof PausedRequest)return false;
        if((signal.aborted||Date.now()>=deadline)&&previous&&!step)return expire();
        if(error!==lastError&&!(signal.aborted&&lastError)){
            await owner.query("UPDATE agent_steps SET request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND request#>>'{retry,pending}'='true'",[id]).catch(()=>undefined);throw error;
        }
        if(signal.aborted&&lastError)error=lastError;
        return transaction(async client=>{
            run=await lockRun(client,id,run.user_id,token);const known=APICallError.isInstance(error)&&error.statusCode!==undefined;
            await client.query("UPDATE agent_steps SET status=$3,request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND step=$2",[id,step!.step,known?"finished":"unknown"]);
            if(known&&request.kind==="compaction"){await setState(client,run,"waiting_input",{type:"compaction_failed",question:"历史摘要请求失败，自动恢复已结束；原始历史与上下文保留，可以明确重试压缩或结束本轮。"},"AGENT_COMPACTION_FAILED");return false;}
            if(isContextRejection(error)){
                if(contextCheckpoint(run).recovery==="applied"){await setState(client,run,"waiting_input",{type:"context_limit",question:"历史压缩后，上游仍拒绝当前上下文。原历史保留，请缩小当前输入或新建会话；不会再次自动请求。"},"AGENT_CONTEXT_LIMIT");return false;}
                await client.query("UPDATE agent_runs SET context_checkpoint=jsonb_set(context_checkpoint,'{recovery}','\"required\"') WHERE id=$1",[id]);await item(client,run,"system","上游明确拒绝上下文过长，将压缩完整旧轮次后继续一次；原始历史保留。");return true;
            }
            const code=signal.aborted||Date.now()>=deadline?"AGENT_MODEL_RETRY_TIMEOUT":attempts>1&&retryableAgentError(error)?"AGENT_MODEL_RETRIES_EXHAUSTED":known?"AGENT_MODEL_REJECTED":"AGENT_MODEL_UNKNOWN";
            await setState(client,run,known?"failed":"unknown",known?null:{type:"unknown_model",question:"文本推理恢复已停止，模型结果不明，可能已计费；请结束原运行后明确发起新尝试。"},code);
            await item(client,run,"system",`文本推理未完成，本次共请求 ${attempts} 次，已停止自动执行。${known?"上游返回失败，请检查服务与模型配置。":"结果未知，失败尝试可能已计费。"}`);
            return false;
        },owner);
    }
}
