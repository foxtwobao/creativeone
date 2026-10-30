import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, stepCountIs, type ModelMessage } from "ai";
import { inlineStoredFile } from "../storage.js";
import { HttpError } from "../http.js";
import { upstreamUrl } from "../tokenone.js";
import { agentTools, toolArgumentErrors } from "./tools.js";

export async function expandAgentImages(userId:string,messages:ModelMessage[],imageInput=true) {
    const expanded:ModelMessage[]=[];
    for (const message of messages) {
        if (message.role !== "user" || !Array.isArray(message.content)) { expanded.push(message); continue; }
        const content=[];
        for (const part of message.content) {
            if (part.type !== "image") {content.push(part);continue;}
            if(!imageInput){content.push({type:"text" as const,text:"当前推理模型不支持读取此前的图片画面；原附件保留，仅可用于文件参考。"});continue;}
            if (typeof part.image !== "string" || !part.image.startsWith("/api/files/")) throw new HttpError(400,"INVALID_FILE_REFERENCE");
            content.push({...part,image:await inlineStoredFile(userId,part.image)});
        }
        expanded.push({...message,content});
    }
    return expanded;
}
// One SDK decision only. No execute callbacks: persistence always precedes effects.
export async function agentDecision(model:string,key:string,system:string,messages:ModelMessage[],limits:{outputTokens?:number},signal:AbortSignal,mode:"decision"|"summary"="decision",onText?:(text:string)=>Promise<void>) {
    const provider=createOpenAI({apiKey:key,baseURL:upstreamUrl(""),fetch:(url,options) => fetch(url,{...options,redirect:"error"})});
    const options={model:provider.responses(model),system,messages,...(mode === "decision" ? {tools:agentTools} : {}),maxRetries:0,...(limits.outputTokens === undefined ? {} : {maxOutputTokens:limits.outputTokens}),stopWhen:stepCountIs(1),abortSignal:signal,providerOptions:{openai:{store:false,parallelToolCalls:false}}};
    let result:any,body:any;
    if (onText) {
        const stream=streamText({...options,includeRawChunks:true,onError:()=>{}});let text="";
        for await (const part of stream.fullStream) {
            if (part.type === "error") throw part.error;
            if (part.type === "text-delta") {text+=part.text;await onText(text);}
            if (part.type === "raw") {const raw=part.rawValue as any;if (["response.completed","response.incomplete","response.failed"].includes(raw?.type)) body=raw.response;}
        }
        if(!body)throw new Error("AGENT_STREAM_INCOMPLETE");
        result={text:await stream.text,toolCalls:await stream.toolCalls,finishReason:await stream.finishReason,response:await stream.response,usage:await stream.totalUsage};
    } else {result=await generateText(options);body=result.response.body;}
    const calls:Array<{toolCallId:string;toolName:string;input:unknown;invalid:boolean}>=result.toolCalls.map((call:any) => ({toolCallId:call.toolCallId,toolName:call.toolName,input:call.input ?? null,invalid:call.invalid === true}));
    const argumentErrors=toolArgumentErrors(calls);
    const complete=(mode === "decision" || calls.length === 0) && ["stop","tool-calls"].includes(result.finishReason) && body?.status === "completed" && !body.output?.some((item:any) => item.type === "message" && item.content?.some((part:any) => part.type === "refusal")) && (calls.length > 0 || result.text.trim().length > 0) && !calls.slice(0,-1).some(call => ["request_user_input","wait_for_tasks"].includes(call.toolName)) && new Set(calls.map(call => call.toolCallId)).size === calls.length;
    const valid=complete && !argumentErrors.length && calls.every(call => !call.invalid);
    const errorCode=valid ? undefined : result.finishReason === "length" || body?.incomplete_details?.reason === "max_output_tokens" ? "AGENT_MODEL_OUTPUT_LIMIT" : mode === "decision" && complete && argumentErrors.length ? "AGENT_INVALID_TOOL_ARGUMENTS" : "AGENT_INVALID_MODEL_RESPONSE";
    return {decision:{messages:result.response.messages,calls,text:result.text,finishReason:result.finishReason,responseId:result.response.id,raw:body,valid,errorCode,argumentErrors},usage:result.usage};
}
