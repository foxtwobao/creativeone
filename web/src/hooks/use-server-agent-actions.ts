import { useEffect, useRef } from "react";
import { App } from "antd";
import { useLocation, useNavigate } from "react-router-dom";
import { flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";
import { useServerAgentStore } from "@/stores/canvas/use-server-agent-store";
import { acknowledgeAgentUiAction, getAgentUiActions, type AgentUiAction } from "@/services/api/server-agent";
import { cloudApi,cloudSession } from "@/services/api/cloud";
import { useCloudStore } from "@/stores/use-cloud-store";

export function useServerAgentActions() {
    const navigate=useNavigate(),{pathname}=useLocation(),{message}=App.useApp();
    const browser=useRef({navigate,pathname,message});browser.current={navigate,pathname,message};
    const interval=useServerAgentStore(state=>state.pollIntervalMs),watchId=useServerAgentStore(state=>state.actionWatchId);
    const sessionError=useCloudStore(state=>state.errors.session);
    useEffect(()=>{
        const controller=new AbortController();
        if(!cloudSession||sessionError){useServerAgentStore.setState({enabled:false,config:undefined,pollIntervalMs:undefined});return;}
        const refresh=()=>{if(!document.hidden)void useServerAgentStore.getState().loadConfig(controller.signal).catch(()=>{if(!controller.signal.aborted)useServerAgentStore.setState({enabled:false});});};
        refresh();document.addEventListener("visibilitychange",refresh);
        return()=>{controller.abort();document.removeEventListener("visibilitychange",refresh);};
    },[pathname,sessionError]);
    useEffect(()=>{
        if(!interval || !watchId)return;
        const controller=new AbortController();let running=false;
        const tick=async()=>{
            const state=useServerAgentStore.getState();
            if(document.hidden || running || state.canvasAction)return;
            running=true;let currentAction:AgentUiAction|undefined;
            try{
                const result=await getAgentUiActions(state.clientId,controller.signal);
                for(const action of result.actions){
                    currentAction=action;
                    if(controller.signal.aborted)return;
                    const data=action.payload;
                    await flushCanvasPersistence();
                    if(data.type==="select_nodes" || data.type==="set_viewport"){
                        useServerAgentStore.setState({canvasAction:action});
                        if(browser.current.pathname!==`/canvas/${data.projectId}`)browser.current.navigate(`/canvas/${data.projectId}`);
                        return;
                    }
                    if(data.type==="site_navigate")browser.current.navigate(data.path);
                    if(data.type==="workbench"){
                        if(data.submitted)useServerAgentStore.setState(state=>({workbenchTasks:{...state.workbenchTasks,[data.kind]:data.taskIds}}));
                        const files=await Promise.all((data.references as string[]).map(url=>cloudApi<any>("/files/info",{method:"POST",body:JSON.stringify({url}),signal:controller.signal})));
                        const images=files.filter(file=>file.mimeType.startsWith("image/")).map(file=>({id:crypto.randomUUID(),name:file.storageKey,type:file.mimeType,dataUrl:file.url,storageKey:file.storageKey}));
                        const media=(kind:string)=>files.filter(file=>file.mimeType.startsWith(`${kind}/`)).map(file=>({...file,id:crypto.randomUUID(),name:file.storageKey,type:file.mimeType}));
                        const {runSiteTool}=await import("@/lib/agent/agent-site-tools");
                        const p=data.parameters;
                        await runSiteTool(data.kind==="image"?"workbench_image_generate":"workbench_video_generate",{model:data.model,prompt:data.prompt,count:data.count,quality:p.quality,background:p.background,size:data.kind==="image"?p.size:p.videoSize,resolution:p.vquality,seconds:p.seconds,mode:p.videoMode,...p.generateAudio!==undefined?{generateAudio:p.generateAudio==="true"}:{},...p.watermark!==undefined?{watermark:p.watermark==="true"}:{},references:images,referenceVideos:media("video"),referenceAudios:media("audio"),run:false},browser.current.navigate);
                        browser.current.message.info(data.submitted?"助手已受理任务并填入工作台，结果可在任务与作品中查看。":"助手已填入工作台，尚未生成；点击生成会发起新的请求。");
                    }
                    await acknowledgeAgentUiAction(action.id,state.clientId);currentAction=undefined;
                }
                if(!result.active && useServerAgentStore.getState().actionWatchId===watchId)useServerAgentStore.setState({actionWatchId:null});
            }catch(error){
                if(!controller.signal.aborted){
                    if(currentAction)await acknowledgeAgentUiAction(currentAction.id,state.clientId,(error as Error).message).catch(()=>useServerAgentStore.setState({actionWatchId:null}));
                    browser.current.message.error({key:"server-agent-browser-action",content:(error as Error).message});
                }
            }finally{running=false;}
        };
        void tick();const timer=setInterval(()=>void tick(),interval);
        const visible=()=>{if(!document.hidden)void tick();};document.addEventListener("visibilitychange",visible);
        return()=>{clearInterval(timer);controller.abort();document.removeEventListener("visibilitychange",visible);};
    },[interval,watchId]);
}
