import { useMemo, type CSSProperties } from "react";
import { App } from "antd";
import { Ban, Check, ChevronRight, CircleAlert, LocateFixed } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { agentTimeline, canvasReferences, canvasReferencePlugin, hasCanvasReferences, nodeLabels, toolAction, agentToolErrorMessage, type AgentEntry } from "./canvas-server-agent-format";

const markdownClass="min-w-0 break-words text-[13px] leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_li>p]:my-0 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h4]:font-semibold [&_strong]:font-semibold [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--agent-border)] [&_pre]:p-2 [&_code]:break-all [&_code]:font-mono [&_code]:text-[11px] [&_pre_code]:break-normal [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--agent-border)] [&_blockquote]:pl-3 [&_hr]:my-3 [&_th]:border-b [&_th]:border-[var(--agent-border)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th:first-child]:whitespace-nowrap [&_th]:align-top [&_th]:font-medium [&_td]:border-b [&_td]:border-[var(--agent-border)] [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_td:first-child]:whitespace-nowrap [&_td]:leading-5";
const button="inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left align-baseline text-xs hover:bg-black/5 dark:hover:bg-white/10";

export default function CanvasServerAgentTimeline({items,onFocusNode,onRetry}:{items:AgentEntry[];onFocusNode:(id:string)=>void;onRetry?:(item:AgentEntry)=>void}) {
    const theme=canvasThemes[useThemeStore(state=>state.theme)],{message}=App.useApp();
    const nodes=useCanvasStore(state=>state.nodes),connections=useCanvasStore(state=>state.connections);
    const references=useMemo(()=>canvasReferences(items,nodes,connections),[items,nodes,connections]);
    const plugins=useMemo(()=>[remarkGfm,canvasReferencePlugin(references)],[references]);
    const timeline=useMemo(()=>agentTimeline(items),[items]);
    const focus=(id:string)=>{const node=useCanvasStore.getState().nodes.find(node=>node.id===id||(node as any).entityId===id);if(node)onFocusNode(node.id);else message.info("节点已变化或删除，请查看当前画布");};
    const tools=(entries:AgentEntry[])=>{
        const errors=entries.filter(item=>item.detail?.result?.error),declined=entries.filter(item=>item.detail?.result?.declined);
        return <div className="space-y-1.5 text-xs" style={{color:theme.node.muted}}><details className="group/tools">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 shrink-0 transition-transform group-open/tools:rotate-90"/><span className="min-w-0 flex-1 truncate">{[...new Set(entries.map(toolAction))].join(" · ")}</span><span className="shrink-0 text-[11px]">{entries.length} 项记录{errors.length?` · ${errors.length} 项未完成`:""}{declined.length?` · ${declined.length} 项已拒绝`:""}</span></summary>
            <div className="ml-1.5 space-y-3 border-l py-2 pl-3" style={{borderColor:theme.node.stroke}}>{entries.map(item=><div key={`${item.threadId}:${item.turnId}:${item.itemId}`} className="space-y-1">
                <p className="flex items-center gap-1.5">{item.detail?.result?.error?<CircleAlert className="size-3"/>:item.detail?.result?.declined?<Ban className="size-3"/>:<Check className="size-3"/>}{toolAction(item)}{item.detail?.result?.error?" · 未完成":""}</p>
                {item.detail?.result?.nodes?.length?<div className="flex flex-wrap gap-1">{item.detail.result.nodes.map((node:any)=><button key={node.id} type="button" className={button} onClick={()=>focus(node.id)}><LocateFixed className="size-3 shrink-0"/><span className="break-words">{item.detail.result.updatedNodeIds?.includes(node.id)?"更新 · ":item.detail.result.reusedNodeIds?.includes(node.id)?"复用 · ":item.detail.result.createdNodeIds?.includes(node.id)?"新建 · ":""}{nodeLabels[node.type]||"节点"} · {node.title||"未命名"}</span></button>)}</div>:null}
                {item.detail?.result?.deletedNodeIds?.length?<p>已移除 {item.detail.result.deletedNodeIds.length} 个节点，后台任务与作品保留。</p>:null}
                {item.detail?.result?.taskIds?.length?<Link className="inline-block underline underline-offset-2" to="/assets">查看关联任务与作品（{item.detail.result.taskIds.length}）</Link>:null}
            </div>)}</div>
        </details>{errors.map(item=><p role="alert" key={item.itemId} className="border-l-2 pl-2 leading-5" style={{borderColor:theme.node.stroke,color:theme.node.text}}>{toolAction(item)}：{agentToolErrorMessage(item.detail.result)}</p>)}{entries.filter(item=>item.detail?.result?.notice).map(item=><p key={item.itemId} className="border-l pl-2 leading-5" style={{borderColor:theme.node.stroke}}>{item.detail.result.notice}</p>)}</div>;
    };
    return <>{timeline.map(entry=>entry.type==="tools"?<div key={`${entry.items[0].threadId}:${entry.items[0].turnId}:${entry.items[0].itemId}`}>{tools(entry.items)}</div>:<article key={`${entry.item.threadId}:${entry.item.turnId}:${entry.item.itemId}`} className={entry.item.role==="user"?"ml-6 border-l-2 pl-3":"min-w-0"} style={{borderColor:theme.node.stroke}}>
        <div className="mb-1 text-[11px]" style={{color:theme.node.muted}}>{entry.item.role==="user"?"你":entry.item.role==="assistant"?"助手":"运行提示"}</div>
        {entry.item.role==="assistant"?<>
            <div className={markdownClass} style={{"--agent-border":theme.node.stroke} as CSSProperties}><Markdown remarkPlugins={plugins} skipHtml disallowedElements={["img"]} components={{
                table:({children})=><div className="my-2 overflow-x-auto rounded-md border" style={{borderColor:theme.node.stroke}}><table className="w-full border-collapse text-xs">{children}</table></div>,
                a:({href,children,title})=>{const reference=href?.startsWith("#canvas-node=")?Array.from(references.values()).find(value=>encodeURIComponent(value.nodeId)===href.slice(13)):undefined;return reference?<button type="button" className={`${button} underline decoration-current/30 underline-offset-2`} title={title} onClick={()=>focus(reference.nodeId)}>{children}</button>:<a href={href} title={title} target="_blank" rel="noreferrer" className="underline underline-offset-2">{children}</a>;},
            }}>{entry.item.text}</Markdown></div>
            {hasCanvasReferences(entry.item.text,references)?<details className="mt-2 text-[11px]" style={{color:theme.node.muted}}><summary className="cursor-pointer">查看原始内容与标识</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{entry.item.text}</pre></details>:null}
        </>:<p className="whitespace-pre-wrap break-words text-[13px] leading-6">{entry.item.text}</p>}
        {entry.item.detail?.attachments?.length?<div className="mt-2 flex flex-wrap gap-2 text-[11px]">{entry.item.detail.attachments.map((file:any,index:number)=>file.kind==="text"?<details key={index}><summary className="cursor-pointer">{file.title}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{file.text}</pre></details>:<a key={index} href={file.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{file.kind==="image"?<img alt="" src={`${file.url}?preview=1`} className="size-8 rounded object-cover"/>:null}{file.title}</a>)}</div>:null}
        {entry.item.detail?.streaming?<p className="mt-1 text-[11px]" style={{color:theme.node.muted}}>正在输出…</p>:null}
        {entry.item.detail?.incomplete?<p className="mt-1 text-[11px]" style={{color:theme.node.muted}}>本段输出未完成，未执行不完整工具。</p>:null}
        {onRetry&&entry.item.role==="assistant"&&!entry.item.detail?.streaming?<button type="button" className={`${button} mt-1`} onClick={()=>onRetry(entry.item)}>重试本次目标</button>:null}
        {entry.item.detail?.skills?.length?<p className="mt-1 text-[11px]" style={{color:theme.node.muted}}>{entry.item.detail.skills.map((skill:any)=>`${skill.title} v${skill.version}`).join(" · ")}</p>:null}
    </article>)}</>;
}
