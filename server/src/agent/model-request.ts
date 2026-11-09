import type pg from "pg";
import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { delay } from "@ai-sdk/provider-utils";
import { createAssistantMessageEventStream, isContextOverflow, type AssistantMessage, type Model, type TranscriptContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { transaction } from "../db.js";
import { ensureKey,modelProvider } from "../tokenone.js";
import { findCanvasProject } from "../business.js";
import { HttpError } from "../http.js";
import { readAgentConfig } from "./config.js";
import { assertSources,toolSchemas } from "./tools.js";
import { toolJsonSchema } from "./schema.js";
import { agentEvents } from "./events.js";
import { lockRun,setState,item,digest,type Run } from "./state.js";

export const retryableAgentError=(error:unknown)=>APICallError.isInstance(error)
    ? error.isRetryable && (error.statusCode===undefined || [408,409,429].includes(error.statusCode) || error.statusCode>=500)
    : error instanceof TypeError || error instanceof Error && error.message==="AGENT_STREAM_INCOMPLETE" || error instanceof HttpError && error.code==="AGENT_MODEL_EMPTY_RESPONSE";
export function agentRetryDelay(error:unknown,fallback:number){
    const headers=APICallError.isInstance(error)?error.responseHeaders:undefined,ms=headers?.["retry-after-ms"],value=headers?.["retry-after"];
    const parsed=ms!==undefined?Number(ms):value!==undefined?(Number.isFinite(Number(value))?Number(value)*1000:Date.parse(value)-Date.now()):NaN;
    return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;
}

// Every actual provider attempt is journalled. Pi's nested retries remain disabled.
export function requestPiModel(owner:pg.Client,initial:Run,token:string,cancel:AbortSignal,model:Model<"openai-responses">,context:TranscriptContext,kind:"decision"|"compaction"="decision",options?:SimpleStreamOptions) {
    const output=createAssistantMessageEventStream(),iterate=output[Symbol.asyncIterator].bind(output);
    let started=false;
    const finished=request();
    output.result=()=>finished;
    output[Symbol.asyncIterator]=async function*(){yield* {[Symbol.asyncIterator]:iterate};await finished;};
    void finished.catch(()=>output.end());
    return output;
    async function request():Promise<AssistantMessage>{
    let run=initial;
    const contextHash=digest({...context,messages:context.messages.map(({timestamp,...message})=>message)});
    if(kind==="compaction"){
        const saved=(await owner.query("SELECT decision FROM agent_steps WHERE run_id=$1 AND kind='compaction' AND status='decided' AND request->>'contextHash'=$2 ORDER BY step LIMIT 1",[run.id,contextHash])).rows[0];
        if(saved?.decision.valid){output.push({type:"done",reason:"stop",message:saved.decision.native});return saved.decision.native;}
    }
    const prior=(await owner.query("SELECT request FROM agent_steps WHERE run_id=$1 AND status='finished' AND request#>>'{retry,pending}'='true' ORDER BY step DESC LIMIT 1",[run.id])).rows[0]?.request.retry;
    const deadline=prior?.deadline??Date.now()+run.model_config.limits.requestTimeoutMs;
    let attempt=prior?.attempt??0,retryAt=prior?.retryAt??0;
    if(deadline<=Date.now()){
        await transaction(async client=>{run=await lockRun(client,run.id,run.user_id,token);await setState(client,run,prior?.known===false?"unknown":"failed",null,"AGENT_MODEL_RETRY_TIMEOUT");},owner);
        throw new HttpError(409,"AGENT_MODEL_RETRY_TIMEOUT");
    }
    const signal=AbortSignal.any([cancel,...(options?.signal?[options.signal]:[]),AbortSignal.timeout(deadline-Date.now())]);
    for(;;){
        try{
            if(retryAt>Date.now())await delay(Math.min(retryAt,deadline)-Date.now(),{abortSignal:signal});
            signal.throwIfAborted();
            if(retryAt>=deadline||Date.now()>=deadline)throw new HttpError(409,"AGENT_MODEL_RETRY_TIMEOUT");
        }
        catch(error){
            if(cancel.aborted)throw error;
            await transaction(async client=>{
                run=await lockRun(client,run.id,run.user_id,token);
                const last=(await client.query("SELECT request FROM agent_steps WHERE run_id=$1 ORDER BY step DESC LIMIT 1",[run.id])).rows[0];
                await client.query("UPDATE agent_steps SET request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND request#>>'{retry,pending}'='true'",[run.id]);
                await setState(client,run,last?.request.retry?.known===false?"unknown":"failed",null,"AGENT_MODEL_RETRY_TIMEOUT");
            },owner);throw error;
        }
        const allowed=await transaction(async client=>{
            run=await lockRun(client,run.id,run.user_id,token);
            if(run.decision_count-run.budget_start.decisions<run.model_config.limits.decisionBudget)return true;
            await setState(client,run,"waiting_input",{type:"budget",question:`本轮已达到 ${run.model_config.limits.decisionBudget} 次模型调用，已有成果已保存。继续可能产生额外推理费用。`});return false;
        },owner);
        if(!allowed)throw new HttpError(409,"AGENT_BUDGET_PAUSED");
        const config=await readAgentConfig(owner);
        if(!config.enabled)throw new HttpError(503,"AGENT_DISABLED");
        if(run.model_config.provider!==modelProvider||!config.verifiedModels.some(entry=>entry.model===run.model_config.model)||!(await owner.query("SELECT id FROM channels WHERE id=$1 AND enabled AND capability='text' AND models ? $2",[run.model_config.channelId,run.model_config.model])).rowCount)throw new HttpError(403,"AGENT_MODEL_UNAVAILABLE");
        const user=(await owner.query("SELECT * FROM users WHERE id=$1",[run.user_id])).rows[0],key=await ensureKey(user,run.id,{signal});
        const itemId=randomUUID();
        const step=await transaction(async client=>{
            run=await lockRun(client,run.id,run.user_id,token);
            if(run.decision_count-run.budget_start.decisions>=run.model_config.limits.decisionBudget){await setState(client,run,"waiting_input",{type:"budget",question:`本轮已达到 ${run.model_config.limits.decisionBudget} 次模型调用，已有成果已保存。继续可能产生额外推理费用。`});return;}
            await assertSources(run,await findCanvasProject(run.user_id,run.project_id,client));
            attempt++;const number=run.decision_count+1;
            await client.query("UPDATE agent_steps SET request=jsonb_set(request,'{retry,pending}','false') WHERE run_id=$1 AND request#>>'{retry,pending}'='true'",[run.id]);
            await client.query("INSERT INTO agent_steps(run_id,step,item_id,status,request,kind) VALUES($1,$2,$3,'requesting',$4,$5)",[run.id,number,itemId,JSON.stringify({kind,contextHash,retry:{attempt,deadline}}),kind]);
            await client.query("UPDATE agent_runs SET decision_count=$2 WHERE id=$1",[run.id,number]);return number;
        },owner);
        if(!step)throw new HttpError(409,"AGENT_BUDGET_PAUSED");
        let raw:any,transportError:unknown,responseMessage:AssistantMessage|undefined,text="",receivedEvent=false,emptyResponse=false;
        try{
            const response=stream(model,context,{...options,apiKey:key.key,signal,maxRetries:0,identity:{attribution:null},
                maxTokens:kind==="compaction"?run.model_config.limits.summaryTokens:run.model_config.limits.outputTokens,
                fetch:async(url,options)=>{
                    try{
                        const value=await fetch(url,{...options,redirect:"error"});
                        if(!value.ok){
                            transportError=new APICallError({message:"Agent provider rejected request",url:String(url),requestBodyValues:{},statusCode:value.status,responseHeaders:Object.fromEntries(value.headers),responseBody:await value.clone().text(),isRetryable:[408,409,429].includes(value.status)||value.status>=500});
                        }return value;
                    }catch(error){transportError=error;throw error;}
                },
                onPayload:async payload=>{
                    const native=await options?.onPayload?.(payload,model)??payload;
                    const body={...native as any,parallel_tool_calls:false,tools:(native as any).tools?.map((tool:any)=>({...tool,parameters:toolJsonSchema(toolSchemas[tool.name as keyof typeof toolSchemas]),strict:true}))};
                    await owner.query("UPDATE agent_steps SET request=request || $3::jsonb WHERE run_id=$1 AND step=$2",[run.id,step,JSON.stringify({payload:body})]);return body;
                },
                onProviderStreamEvent:async(event:any)=>{
                    await options?.onProviderStreamEvent?.(event,model);
                    if(event.type?.startsWith("response."))receivedEvent=true;
                    if(["response.completed","response.incomplete","response.failed"].includes(event.type))raw=event.response;
                },
            });
            let terminal;
            for await(const event of response){
                if(event.type==="done"||event.type==="error"){terminal=event;break;}
                if(event.type==="start"){if(started)continue;started=true;}
                if(kind==="decision"&&event.type==="text_delta"){
                        text+=event.delta;
                        const detail={step,streaming:true};
                        const updated=await owner.query("INSERT INTO agent_items(thread_id,turn_id,item_id,role,text,detail) SELECT thread_id,id,$2,'assistant',$3,$4 FROM agent_runs WHERE id=$1 AND execution_token=$5 AND status='running' ON CONFLICT(item_id) DO UPDATE SET text=EXCLUDED.text WHERE agent_items.thread_id=EXCLUDED.thread_id AND agent_items.turn_id=EXCLUDED.turn_id AND agent_items.detail->>'streaming'='true' RETURNING item_id",[run.id,itemId,text,JSON.stringify(detail),token]);
                        if(updated.rowCount){agentEvents.emit(run.thread_id,{threadId:run.thread_id,turnId:run.id,itemId,role:"assistant",text,detail});await owner.query("SELECT pg_notify('creativeone_agent_items',$1)",[JSON.stringify({threadId:run.thread_id,turnId:run.id,itemId})]);}
                }
                output.push(event);
            }
            const message=await response.result();
            responseMessage=message;
            if(transportError)throw transportError;
            if(!raw||!terminal)throw receivedEvent?new Error("AGENT_STREAM_INCOMPLETE"):new HttpError(409,"AGENT_INVALID_MODEL_RESPONSE");
            text=message.content.filter(part=>part.type==="text").map(part=>part.text).join("");
            const rawCalls=raw.output?.filter((part:any)=>part.type==="function_call")||[];
            const calls=message.content.filter(part=>part.type==="toolCall").map((part,index)=>({nativeId:part.id,toolCallId:rawCalls[index]?.call_id,toolName:part.name,input:part.arguments,argumentsError:part.argumentsError}));
            emptyResponse=kind==="decision"&&raw.status==="completed"&&message.stopReason==="stop"&&!raw.error&&!raw.incomplete_details&&!calls.length&&!rawCalls.length&&!text.trim()&&raw.output?.every((entry:any)=>entry.type==="reasoning"||entry.type==="message"&&entry.content?.every((part:any)=>part.type==="output_text"&&!part.text.trim()));
            if(emptyResponse)throw new HttpError(409,"AGENT_MODEL_EMPTY_RESPONSE");
            const valid=raw.status==="completed"&&["stop","toolUse"].includes(message.stopReason)&&calls.every(call=>typeof call.toolCallId==="string"&&call.toolCallId)&&new Set(calls.map(call=>call.toolCallId)).size===calls.length&&!raw.output?.some((entry:any)=>entry.content?.some((part:any)=>part.type==="refusal"))&&(calls.length>0||message.content.some(part=>part.type==="text"&&part.text.trim()))&&(kind==="decision"||calls.length===0&&message.usage.output<=run.model_config.limits.summaryTokens);
            const code=message.stopReason==="length"?"AGENT_MODEL_OUTPUT_LIMIT":"AGENT_INVALID_MODEL_RESPONSE";
            await transaction(async client=>{
                run=await lockRun(client,run.id,run.user_id,token);
                await client.query("UPDATE agent_steps SET status='decided',decision=$3,usage=$4 WHERE run_id=$1 AND step=$2",[run.id,step,JSON.stringify({native:message,calls,text,valid,raw,finishReason:message.stopReason==="toolUse"?"tool-calls":message.stopReason,errorCode:valid?undefined:code}),JSON.stringify(message.usage)]);
                await client.query("UPDATE agent_runs SET token_count=token_count+$2,pi_context_recovered=CASE WHEN $3='decision' THEN false ELSE pi_context_recovered END WHERE id=$1",[run.id,message.usage.totalTokens||0,kind]);
                if(kind==="decision")await item(client,run,"assistant",text,{step,tools:calls.map(call=>({name:call.toolName,callId:call.toolCallId})),usage:message.usage},itemId);
                if(!valid)await setState(client,run,kind==="compaction"?"waiting_input":"failed",kind==="compaction"?{type:"compaction_failed",question:"摘要未完成，原始历史保留，可明确重试压缩。"}:null,kind==="compaction"?"AGENT_COMPACTION_FAILED":code);
            },owner);
            if(!valid)throw new HttpError(409,code);
            output.push(terminal);return message;
        }catch(error){
            const current=(await owner.query("SELECT status FROM agent_runs WHERE id=$1",[run.id])).rows[0];if(current?.status!=="running")throw error;
            const known=emptyResponse||APICallError.isInstance(error)&&error.statusCode!==undefined;
            if(kind==="decision"&&!emptyResponse&&known&&responseMessage&&isContextOverflow(responseMessage)){
                await transaction(async client=>{
                    run=await lockRun(client,run.id,run.user_id,token);
                    await client.query("UPDATE agent_steps SET status='finished',decision=$3 WHERE run_id=$1 AND step=$2",[run.id,step,JSON.stringify({status:(error as APICallError).statusCode,body:(error as APICallError).responseBody})]);
                    const recovered=(await client.query("SELECT pi_context_recovered FROM agent_runs WHERE id=$1",[run.id])).rows[0].pi_context_recovered;
                    if(recovered)await setState(client,run,"waiting_input",{type:"context_limit",question:"历史压缩后上游仍拒绝上下文，完整历史保留，请缩小输入。"},"AGENT_CONTEXT_LIMIT");
                    else{await client.query("UPDATE agent_runs SET pi_needs_compaction=true WHERE id=$1",[run.id]);await setState(client,run,"queued");}
                },owner);throw error;
            }
            const retry=!signal.aborted&&retryableAgentError(error)&&attempt<=(run.model_config.limits.modelRetries??0);
            const wait=agentRetryDelay(error,2000*2**(attempt-1));retryAt=Date.now()+wait;
            await transaction(async client=>{
                run=await lockRun(client,run.id,run.user_id,token);
                await client.query("UPDATE agent_steps SET status=$3,decision=$4,request=jsonb_set(request,'{retry}',$5),usage=COALESCE($6::jsonb,usage) WHERE run_id=$1 AND step=$2",[run.id,step,retry||known?"finished":"unknown",JSON.stringify({...(emptyResponse?{native:responseMessage,calls:[],text,valid:false,finishReason:"stop",errorCode:"AGENT_MODEL_EMPTY_RESPONSE"}:{}),raw,error:error instanceof Error?error.name:"Error",message:error instanceof Error?error.message:"Unknown",status:known?(error as APICallError).statusCode:undefined,body:known?(error as APICallError).responseBody:undefined}),JSON.stringify({attempt,deadline,retryAt,pending:retry,known}),emptyResponse?JSON.stringify(responseMessage!.usage):null]);
                if(emptyResponse)await client.query("UPDATE agent_runs SET token_count=token_count+$2 WHERE id=$1",[run.id,responseMessage!.usage.totalTokens||0]);
                if(retry){await item(client,run,"system",`${emptyResponse?"模型未返回正文或工具调用":"文本推理暂时失败"}，等待后自动重试 ${attempt}/${run.model_config.limits.modelRetries}；计入调用预算，失败尝试也可能计费。`,{kind:"model_retry"});}
                else await setState(client,run,known?"failed":"unknown",known?null:{type:"unknown_model",question:"模型结果未知，可能已计费；不会自动重发，请结束后明确发起新尝试。"},signal.aborted?"AGENT_MODEL_RETRY_TIMEOUT":attempt>1&&retryableAgentError(error)?"AGENT_MODEL_RETRIES_EXHAUSTED":emptyResponse?"AGENT_MODEL_EMPTY_RESPONSE":known?"AGENT_MODEL_REJECTED":"AGENT_MODEL_UNKNOWN");
            },owner);
            if(!retry)throw error;
        }
    }
}
}
