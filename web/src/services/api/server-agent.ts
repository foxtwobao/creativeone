import { cloudApi, cloudSession } from "./cloud";

export type AgentRun = {id:string;threadId:string;submissionId:string;goal:string;status:string;waitVersion:number;wait:any;error?:string;errorMessage?:string;model:string;decisionCount:number;tokenCount:number;skills?:Array<{id:string;title:string;version:number}>};
export type AgentThread = {id:string;projectId:string;title:string;activeRunId:string|null;creativeState:any;runs:AgentRun[];items:Array<{threadId:string;turnId:string;itemId:string;role:string;text:string;detail?:any}>};
export type AgentAttachment={kind:"text";title:string;text:string}|{kind:"image"|"video"|"audio";title:string;url:string};
export type AgentSubmission = {submissionId:string;goal:string;selectedNodeIds:string[];model:string;baseRevision:number;baseGenerationRevision:number;skillIds?:string[];attachments?:AgentAttachment[];clientId?:string};
export type AgentAvailability={enabled:boolean;models:string[];imageModels:string[];inputCharacters:number;pollIntervalMs?:number};
export const getAgentConfig=(signal?:AbortSignal) => cloudApi<AgentAvailability>("/agent/config",{signal});
export const listAgentThreads=(project:string) => cloudApi<{threads:Array<{id:string;title:string;activeRunId:string|null}>}>(`/projects/${project}/agent/threads`);
export const getAgentThread=(id:string,signal?:AbortSignal) => cloudApi<AgentThread>(`/agent/threads/${id}`,{signal});
export const createAgentThread=(project:string,title:string) => cloudApi<{id:string}>(`/projects/${project}/agent/threads`,{method:"POST",body:JSON.stringify({title})});
export const submitAgentRun=(thread:string,input:AgentSubmission) => cloudApi<{run:AgentRun}>(`/agent/threads/${thread}/runs`,{method:"POST",body:JSON.stringify(input)});
export const confirmAgentRun=(run:string,waitVersion:number,approve:boolean) => cloudApi(`/agent/runs/${run}/confirm`,{method:"POST",body:JSON.stringify({waitVersion,approve})});
export const answerAgentRun=(run:string,waitVersion:number,action:string,text?:string,answers?:Record<string,string>) => cloudApi(`/agent/runs/${run}/input`,{method:"POST",body:JSON.stringify({waitVersion,action,text,answers})});
export const cancelAgentRun=(run:string) => cloudApi(`/agent/runs/${run}/cancel`,{method:"POST"});
export const renameAgentThread=(id:string,title:string)=>cloudApi(`/agent/threads/${id}`,{method:"PATCH",body:JSON.stringify({title})});
export const deleteAgentThreads=(project:string,ids:string[])=>cloudApi(`/projects/${project}/agent/threads`,{method:"DELETE",body:JSON.stringify({ids})});
export type AgentUiAction={id:string;payload:any};
export const getAgentUiActions=(clientId:string,signal?:AbortSignal)=>cloudApi<{actions:AgentUiAction[];active:boolean}>(`/agent/ui-actions/${clientId}`,{signal});
export const acknowledgeAgentUiAction=(id:string,clientId:string,error?:string)=>cloudApi(`/agent/ui-actions/${id}/ack`,{method:"POST",body:JSON.stringify({clientId,error})});
export function listenAgentThread(id:string,onItem:(item:AgentThread["items"][number])=>void) {
    const source=new EventSource(`/api/agent/threads/${id}/events?userId=${encodeURIComponent(cloudSession?.user.id || "")}`);
    source.onmessage=event=>{try {const item=JSON.parse(event.data);if(item.threadId===id && item.role==="assistant" && item.detail?.streaming)onItem(item);}catch{/* A later snapshot recovers an incomplete event. */}};
    source.onerror=()=>source.close();
    return ()=>source.close();
}

export type AgentSkill = {id:string;title:string;description:string;version:number;source:"builtin"|"personal";hasFiles?:boolean};
export type AgentSkillContent = AgentSkill & {content:string;files:Record<string,string>};
export type AgentSkillInput = {title:string;description:string;content:string;files:Record<string,string>;version?:number};
export const listAgentSkills=() => cloudApi<{skills:AgentSkill[]}>("/agent/skills");
export const readAgentSkill=(id:string) => cloudApi<{skill:AgentSkillContent}>(`/agent/skills/${encodeURIComponent(id)}`);
export const saveAgentSkill=(input:AgentSkillInput,id?:string) => cloudApi<{skill:AgentSkillContent}>(id ? `/agent/skills/${encodeURIComponent(id)}` : "/agent/skills",{method:id ? "PATCH" : "POST",body:JSON.stringify(input)});
export const deleteAgentSkill=(id:string,version:number) => cloudApi(`/agent/skills/${encodeURIComponent(id)}`,{method:"DELETE",body:JSON.stringify({version})});
