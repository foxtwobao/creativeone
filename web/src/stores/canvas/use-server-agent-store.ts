import { create } from "zustand";
import { getAgentConfig,type AgentAvailability,type AgentSubmission,type AgentUiAction } from "@/services/api/server-agent";
import { cloudSession } from "@/services/api/cloud";

export const AGENT_PANEL_MIN_WIDTH=464,AGENT_PANEL_MAX_WIDTH=760;
const WIDTH_KEY="canvas-server-agent-width";
const clampWidth=(width:number)=>Number.isFinite(width)?Math.min(AGENT_PANEL_MAX_WIDTH,Math.max(AGENT_PANEL_MIN_WIDTH,width)):AGENT_PANEL_MIN_WIDTH;
function initialWidth() {
    try {return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || AGENT_PANEL_MIN_WIDTH);} catch {return AGENT_PANEL_MIN_WIDTH;}
}

// Only the device's panel width is saved locally; conversations and accepted requests live on the server.
export const useServerAgentStore=create<{
    enabled:boolean;config?:AgentAvailability;loadConfig:(signal?:AbortSignal)=>Promise<AgentAvailability>;
    open:boolean;width:number;setWidth:(width:number)=>void;saveWidth:()=>void;
    clientId:string;actionWatchId:string|null;pollIntervalMs?:number;canvasAction:AgentUiAction|null;lastProjectId?:string;
    workbenchTasks:Partial<Record<"image"|"video",string[]>>;
    threadIds:Record<string,string>;pending:Record<string,{threadId:string;input:AgentSubmission}>;
    toggle:() => void;select:(projectId:string,threadId:string) => void;
    hold:(projectId:string,pending:{threadId:string;input:AgentSubmission}|null) => void;
}>((set,get) => ({enabled:false,loadConfig:async signal=>{const owner=cloudSession?.user.id,config=await getAgentConfig(signal);if(!signal?.aborted&&cloudSession?.user.id===owner)set({config,enabled:config.enabled,pollIntervalMs:config.enabled?config.pollIntervalMs:undefined});return config;},workbenchTasks:{},clientId:crypto.randomUUID(),actionWatchId:null,canvasAction:null,open:true,width:initialWidth(),setWidth:width=>set({width:clampWidth(width)}),saveWidth:()=>{try {localStorage.setItem(WIDTH_KEY,String(get().width));} catch { /* Layout preferences may be unavailable. */ }},threadIds:{},pending:{},toggle:() => set(state => ({open:!state.open})),select:(projectId,threadId) => set(state => ({threadIds:{...state.threadIds,[projectId]:threadId}})),hold:(projectId,pending) => set(state => {const next={...state.pending};if (pending) next[projectId]=pending;else delete next[projectId];return {pending:next};})}));
