import { useState } from "react";
import { useParams } from "react-router-dom";
import { App, Button, Checkbox, Input, Modal } from "antd";
import { History, Pencil, Trash2 } from "lucide-react";
import { listAgentThreads, renameAgentThread, deleteAgentThreads } from "@/services/api/server-agent";
import { useServerAgentStore } from "@/stores/canvas/use-server-agent-store";

export default function CanvasServerAgentSessions({disabled,onChanged}:{disabled:boolean;onChanged:()=>Promise<void>}) {
    const projectId=useParams<{id:string}>().id || "",{modal,message}=App.useApp();
    const [open,setOpen]=useState(false),[threads,setThreads]=useState<Array<{id:string;title:string}>>([]),[selected,setSelected]=useState<string[]>([]),[query,setQuery]=useState(""),[renaming,setRenaming]=useState<{id:string;title:string}>(),[busy,setBusy]=useState(false);
    const reload=async()=>{setThreads((await listAgentThreads(projectId)).threads);await onChanged();};
    const remove=()=>modal.confirm({title:`删除 ${selected.length} 条会话？`,content:"对话与助手运行记录会删除，助手停止后续步骤；已有画布节点、作品和已受理媒体任务继续保留。",okText:"删除",cancelText:"保留",okButtonProps:{danger:true},onOk:async()=>{await deleteAgentThreads(projectId,selected);const state=useServerAgentStore.getState();if(selected.includes(state.threadIds[projectId]))state.select(projectId,"");setSelected([]);await reload();}});
    return <>
        <button type="button" title="管理会话" aria-label="管理会话" disabled={disabled} className="rounded-md p-2 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40" onClick={()=>{setOpen(true);setSelected([]);void reload().catch(error=>message.error(error.message));}}><History className="size-4"/></button>
        <Modal title="创作会话" open={open} onCancel={()=>setOpen(false)} footer={<div className="flex items-center justify-between"><Checkbox checked={Boolean(threads.length)&&selected.length===threads.length} indeterminate={Boolean(selected.length)&&selected.length<threads.length} onChange={event=>setSelected(event.target.checked?threads.map(thread=>thread.id):[])}>全选</Checkbox><Button danger size="small" disabled={!selected.length||busy} onClick={remove}>删除所选</Button></div>}>
            <Input.Search aria-label="搜索创作会话" placeholder="搜索会话名称" value={query} onChange={event=>setQuery(event.target.value)}/>
            <div className="mt-3 max-h-80 space-y-1 overflow-auto">{threads.filter(thread=>thread.title.includes(query)).map(thread=><div key={thread.id} className="flex items-center gap-2 py-1.5"><Checkbox checked={selected.includes(thread.id)} onChange={event=>setSelected(current=>event.target.checked?[...current,thread.id]:current.filter(id=>id!==thread.id))}/><button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={()=>{useServerAgentStore.getState().select(projectId,thread.id);setOpen(false);}}>{thread.title}</button><Button type="text" size="small" aria-label={`重命名 ${thread.title}`} icon={<Pencil className="size-3.5"/>} onClick={()=>setRenaming(thread)}/><Button type="text" size="small" aria-label={`删除 ${thread.title}`} icon={<Trash2 className="size-3.5"/>} onClick={()=>{modal.confirm({title:`删除「${thread.title}」？`,content:"停止此会话的助手步骤并删除记录；画布、作品和已受理媒体任务保留。",okText:"删除",cancelText:"保留",okButtonProps:{danger:true},onOk:async()=>{await deleteAgentThreads(projectId,[thread.id]);const state=useServerAgentStore.getState();if(state.threadIds[projectId]===thread.id)state.select(projectId,"");setSelected(current=>current.filter(id=>id!==thread.id));await reload();}});}}/></div>)}</div>
        </Modal>
        <Modal title="重命名会话" open={Boolean(renaming)} confirmLoading={busy} onCancel={()=>setRenaming(undefined)} okText="保存" cancelText="取消" onOk={async()=>{if(!renaming?.title.trim())return;setBusy(true);try{await renameAgentThread(renaming.id,renaming.title.trim());setRenaming(undefined);await reload();}catch(error){message.error((error as Error).message);}finally{setBusy(false);}}}><Input aria-label="会话名称" value={renaming?.title || ""} onChange={event=>setRenaming(current=>current?{...current,title:event.target.value}:current)}/></Modal>
    </>;
}
