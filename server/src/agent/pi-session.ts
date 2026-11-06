import { createAgentSession, createExtensionRuntime, CURRENT_SESSION_VERSION, SessionManager, SettingsManager, type FileEntry, type ModelRuntime, type ToolDefinition, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { HttpError } from "../http.js";

export type PiSnapshot={version:1;signature:string;entries:FileEntry[]};
export interface PiSessionPersistence {
    load():Promise<PiSnapshot|undefined>;
    append(snapshot:PiSnapshot,expectedLength:number):Promise<void>;
}
export function validatePiSnapshot(snapshot:PiSnapshot) {
    if(snapshot.version!==1||!snapshot.signature||!Array.isArray(snapshot.entries))throw new HttpError(409,"AGENT_STORAGE_VERSION");
    const [header,...entries]=snapshot.entries;
    if(header?.type!=="session"||header.version!==CURRENT_SESSION_VERSION||!header.id)throw new HttpError(409,"AGENT_STORAGE_VERSION");
    const types=new Set(["message","thinking_level_change","model_change","usage","compaction","context_edit","custom","custom_message","session_info","label"]);
    const ids=new Set<string>();let parent:string|null=null;
    for(const entry of entries){
        if(entry.type==="session"||!types.has(entry.type)||!entry.id||ids.has(entry.id)||entry.parentId!==parent)throw new HttpError(409,"AGENT_CONTEXT_CHECKPOINT_INVALID");
        if(entry.type==="context_edit"&&!ids.has(entry.targetId))throw new HttpError(409,"AGENT_CONTEXT_CHECKPOINT_INVALID");
        ids.add(entry.id);parent=entry.id;
    }
}

// The host owns persistence and request policy; Pi owns the transcript and tool loop.
export async function createCreativeSession(options:{
    cwd:string;signature:string;system:string;runtime:ModelRuntime;
    model:NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
    tools:ToolDefinition<any>[];persistence:PiSessionPersistence;stream:StreamFn;
    signal?:AbortSignal;
    endTurn?:()=>Promise<boolean>;
    prepareResult?:(message:Extract<AgentMessage,{role:"toolResult"}>,context:{waiting:boolean})=>Promise<void>;
    validateDecision:(message:AgentMessage)=>string|undefined;
    onEvent?:(event:AgentSessionEvent)=>void;
}) {
    const saved=await options.persistence.load();
    if(saved){validatePiSnapshot(saved);if(saved.signature!==options.signature)throw new HttpError(409,"AGENT_SESSION_CONFIG_CHANGED");}
    const manager=SessionManager.inMemory(options.cwd,undefined,saved?.entries);
    let durable=saved?.entries.map(entry=>JSON.stringify(entry))||[],failure:unknown,invalid:string|undefined,waiting=false;
    const rawCalls=new Map<string,unknown>();
    const assertActive=()=>{if(failure)throw failure;options.signal?.throwIfAborted();};
    const flush=async()=>{
        assertActive();
        try{
            const entries=[manager.getHeader()!,...manager.getEntries()],serialized=entries.map(entry=>JSON.stringify(entry));
            if(durable.some((body,index)=>serialized[index]!==body))throw new HttpError(409,"AGENT_CONTEXT_CHECKPOINT_INVALID");
            if(serialized.length===durable.length)return;
            const snapshot:PiSnapshot={version:1,signature:options.signature,entries};validatePiSnapshot(snapshot);
            await options.persistence.append(snapshot,durable.length);durable=serialized;
        }catch(error){failure=error;throw error;}
    };
    const {session}=await createAgentSession({
        cwd:options.cwd,model:options.model,modelRuntime:options.runtime,thinkingLevel:"off",
        sessionManager:manager,settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,provider:{maxRetries:0}},cacheWarming:"off"}),
        tools:options.tools.map(tool=>tool.name),customTools:options.tools.map(tool=>({...tool,executionMode:"sequential",constrainedSampling:false,
            execute:async(...args:Parameters<typeof tool.execute>)=>{
                assertActive();await flush();if(rawCalls.has(args[0]))args[1]=structuredClone(rawCalls.get(args[0]));
                let result;try{result=await tool.execute(...args);}catch(error){failure=error;throw error;}
                if(result.terminate)waiting=true;return result;
            },
        })),
        resourceLoader:{
            getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),
            getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),
            getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),
            getSystemPrompt:()=>options.system,getSystemPromptSource:()=>undefined,
            getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{},
        },
    });
    session.agent.toolExecution="sequential";
    session.agent.streamFunction=async(...args)=>{assertActive();await flush();try{return await options.stream(...args);}catch(error){failure=error;throw error;}};
    session.agent.subscribe(async event=>{
        assertActive();
        if(event.type==="message_start"&&event.message.role==="toolResult")await options.prepareResult?.(event.message,{waiting});
        if(event.type==="message_end"){
            if(event.message.role==="assistant"){
                rawCalls.clear();for(const part of event.message.content)if(part.type==="toolCall")rawCalls.set(part.id,part.arguments);
                invalid=options.validateDecision(event.message);
            }
            await flush();
            if(event.message.role==="assistant"&&["error","aborted","length"].includes(event.message.stopReason)){
                failure=new HttpError(409,event.message.stopReason==="length"?"AGENT_MODEL_OUTPUT_LIMIT":"AGENT_INVALID_MODEL_RESPONSE");throw failure;
            }
        }
    });
    const before=session.agent.beforeToolCall,finish=session.agent.finishTurn;
    session.agent.beforeToolCall=async(context,signal)=>{
        assertActive();
        if(invalid||waiting)return {block:true,reason:invalid||"前序操作正在等待确认或结果，本项尚未执行。",terminate:waiting};
        return before?.(context,signal);
    };
    session.agent.finishTurn=async(context,signal)=>waiting||await options.endTurn?.()?{action:"end"}:finish?.(context,signal);
    const abort=()=>session.agent.abort();options.signal?.addEventListener("abort",abort,{once:true});
    if(options.onEvent)session.subscribe(options.onEvent);
    const settle=async(work:()=>Promise<void>)=>{
        assertActive();waiting=false;
        await work();assertActive();await flush();
    };
    return {
        session,flush,
        prompt:(text:string)=>settle(()=>session.prompt(text,{expandPromptTemplates:false})),
        send:(message:Parameters<typeof session.sendCustomMessage>[0],triggerTurn=true)=>settle(()=>session.sendCustomMessage(message,{triggerTurn})),
        resume:()=>settle(()=>session.agent.continue()),
        notify:(content:string,details?:unknown)=>settle(()=>session.sendCustomMessage({customType:"creativeone.business_result",content,details,display:true},{triggerTurn:true})),
        dispose:()=>{options.signal?.removeEventListener("abort",abort);session.dispose();},
    };
}
