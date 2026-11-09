import { useRef, useState } from "react";
import { App, Popover } from "antd";
import { FolderOpen, Plus, Upload, X } from "lucide-react";
import { cloudApi } from "@/services/api/cloud";
import { assertReferenceImageSize } from "@/services/image-storage";
import type { AgentAttachment } from "@/services/api/server-agent";
import { AssetPickerModal, type InsertAssetPayload } from "./asset-picker-modal";
export { clipboardFiles } from "./canvas-agent-clipboard";

export async function agentFileAttachment(file:File):Promise<AgentAttachment> {
    if (/\.(?:txt|md)$/i.test(file.name)) return {kind:"text",title:file.name,text:await file.text()};
    const kind=file.type.startsWith("image/")?"image":file.type.startsWith("video/")?"video":file.type.startsWith("audio/")?"audio":null;
    if(!kind)throw new Error("支持图片、视频、音频和 TXT／Markdown 文本文件");
    if(kind==="image")assertReferenceImageSize(file.size);
    const body=new FormData();body.append("file",file);
    const stored=await cloudApi<{url:string}>("/files/canvas-import",{method:"POST",body});
    return {kind,title:file.name,url:stored.url};
}
export function attachmentFromAsset(asset:InsertAssetPayload):AgentAttachment {
    return asset.kind==="text"?{kind:"text",title:asset.title,text:asset.content}:{kind:asset.kind,title:asset.title,url:asset.kind==="image"?asset.dataUrl:asset.url};
}
export default function CanvasServerAgentAttachments({value,onChange,disabled,inputCharacters,onBusyChange}:{value:AgentAttachment[];onChange:(value:AgentAttachment[])=>void;disabled:boolean;inputCharacters?:number;onBusyChange:(busy:boolean)=>void}) {
    const {message}=App.useApp(),input=useRef<HTMLInputElement>(null);
    const [assetsOpen,setAssetsOpen]=useState(false),[uploading,setUploading]=useState(false);
    const add=(items:AgentAttachment[])=>{
        const next=[...value,...items];
        if(inputCharacters && next.reduce((sum,item)=>sum+item.title.length+(item.kind==="text"?item.text.length:0),0)>inputCharacters)throw new Error(`附件正文超过单次 ${inputCharacters.toLocaleString("zh-CN")} 字符范围，请缩小内容后再发送。`);
        onChange(next);
    };
    const button="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
    return <div className="contents">
        <Popover trigger="click" placement="topLeft" content={<div className="flex flex-col"><button type="button" className={button} onClick={()=>input.current?.click()}><Upload className="size-3.5"/>上传文件</button><button type="button" className={button} onClick={()=>setAssetsOpen(true)}><FolderOpen className="size-3.5"/>我的素材</button></div>}><button type="button" title="添加附件" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40" aria-label={uploading?"正在添加附件":"添加对话附件"} disabled={disabled||uploading}><Plus className="size-5"/></button></Popover>
        <input ref={input} type="file" multiple accept="image/*,video/*,audio/*,.txt,.md" className="hidden" onChange={async event=>{const files=Array.from(event.target.files||[]);event.target.value="";setUploading(true);onBusyChange(true);try{const items=[];for(const file of files)items.push(await agentFileAttachment(file));add(items);}catch(error){message.error((error as Error).message);}finally{setUploading(false);onBusyChange(false);}}}/>
        {value.length ? <div className="order-last flex w-full min-w-0 flex-wrap gap-1">{value.map((item,index)=><span key={index} className="inline-flex max-w-full items-center gap-1 rounded border border-current/15 px-1.5 py-1 text-[11px]" title={item.title}>{item.kind==="image"?<img alt="" src={`${item.url}?preview=1`} className="size-5 rounded object-cover"/>:null}<span className="max-w-32 truncate">{item.title}</span><button type="button" aria-label={`移除附件 ${item.title}`} disabled={disabled} onClick={()=>onChange(value.filter((_,i)=>i!==index))}><X className="size-3"/></button></span>)}</div> : null}
        <AssetPickerModal open={assetsOpen} includeAudio onClose={()=>setAssetsOpen(false)} onInsert={asset=>{try{add([attachmentFromAsset(asset)]);setAssetsOpen(false);}catch(error){message.error((error as Error).message);}}}/>
    </div>;
}
