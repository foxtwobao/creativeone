import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { theme } from "antd";
import { fetchTaskStatuses } from "@/services/api/tasks";
import { useServerAgentStore } from "@/stores/canvas/use-server-agent-store";

const labels:Record<string,string>={pending:"处理中",running:"生成中",succeeded:"已完成",failed:"失败",unknown:"结果待确认",cancelled:"已取消",expired:"已过期"};
export default function WorkbenchAgentNotice({kind}:{kind:"image"|"video"}) {
    const ids=useServerAgentStore(state=>state.workbenchTasks?.[kind]),interval=useServerAgentStore(state=>state.pollIntervalMs),{token}=theme.useToken();
    const [tasks,setTasks]=useState<Array<{id:string;status:string}>>([]),[error,setError]=useState("");
    useEffect(()=>{
        if(!ids?.length||!interval)return;
        const controller=new AbortController();let active=true,running=false;
        const tick=async()=>{
            if(document.hidden||running||!active)return;running=true;
            try{const result=await fetchTaskStatuses(ids,controller.signal);if(!controller.signal.aborted){setTasks(result.tasks);setError("");active=result.tasks.some(task=>["pending","running"].includes(task.status));}}catch(error){if(!controller.signal.aborted)setError((error as Error).message);}finally{running=false;}
        };
        void tick();const timer=setInterval(()=>void tick(),interval),visible=()=>{if(!document.hidden)void tick();};document.addEventListener("visibilitychange",visible);
        return()=>{controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
    },[ids,interval]);
    if(!ids?.length)return null;
    return <div role="status" className="shrink-0 space-y-1 border-b px-5 py-3 text-xs leading-5" style={{color:token.colorText,borderColor:token.colorBorderSecondary}}><p>助手已受理 {ids.length} 项创作 · {ids.map(id=>labels[tasks.find(task=>task.id===id)?.status || ""]||"读取状态中").join(" / ")}</p><p style={{color:token.colorTextSecondary}}>本次生成已锁定，避免重复提交。选择「新建创作」可开始另一项，原任务继续处理。 <Link className="underline" to="/assets">查看任务与作品</Link></p>{error?<p role="alert">状态读取失败：{error}。已有任务保留，不会重发。</p>:null}</div>;
}
