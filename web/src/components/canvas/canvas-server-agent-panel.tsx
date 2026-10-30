import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { App, Button, Input, Popover, Radio, Select, Spin } from "antd";
import { ArrowDown, Bot, Plus, Send, Square, Sparkles, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { AGENT_PANEL_MIN_WIDTH, AGENT_PANEL_MAX_WIDTH, useServerAgentStore } from "@/stores/canvas/use-server-agent-store";
import { agentPhases, agentPresets } from "../../../../shared/agent";
import CanvasServerAgentAttachments, { agentFileAttachment } from "./canvas-server-agent-attachments";
import CanvasServerAgentSessions from "./canvas-server-agent-sessions";
import type { AgentAttachment } from "@/services/api/server-agent";
import CanvasServerAgentSkills from "./canvas-server-agent-skills";
import CanvasServerAgentTimeline from "./canvas-server-agent-timeline";
import { actions, nodeLabels } from "./canvas-server-agent-format";
import { CloudError } from "@/services/api/cloud";
import { answerAgentRun, cancelAgentRun, confirmAgentRun, createAgentThread, getAgentConfig, getAgentThread, listenAgentThread, listAgentThreads, submitAgentRun, type AgentThread } from "@/services/api/server-agent";

const statuses:Record<string,string>={queued:"已受理 · 排队中",running:"正在处理",waiting_input:"等待补充",waiting_confirmation:"等待确认",waiting_tasks:"后台生成中",completed:"已完成",failed:"执行失败",cancelled:"已停止",unknown:"模型结果待确认"};
const taskLabels:Record<string,string>={pending:"后台处理中",running:"正在生成",succeeded:"成功",failed:"失败",unknown:"结果待确认",cancelled:"已取消",expired:"已过期"};
const parameterLabels:Record<string,string>={size:"尺寸",quality:"质量",background:"背景",videoSize:"画幅",seconds:"时长",vquality:"分辨率",videoMode:"素材模式",generateAudio:"生成声音",watermark:"水印",audioInput:"音频文案与角色",reasoningEffort:"推理强度"};

export default function CanvasServerAgentPanel({selectedNodeIds,onFlush,onFocusNode}:{selectedNodeIds:string[];onFlush:() => Promise<void>;onFocusNode:(id:string) => void}) {
    const projectId=useParams<{id:string}>().id || "";
    const {modal}=App.useApp();
    const theme=canvasThemes[useThemeStore(state => state.theme)];
    const open=useServerAgentStore(state => state.open),toggle=useServerAgentStore(state => state.toggle);
    const width=useServerAgentStore(state=>state.width),setWidth=useServerAgentStore(state=>state.setWidth),saveWidth=useServerAgentStore(state=>state.saveWidth);
    const resizeStart=useRef<{x:number;width:number}|null>(null);
    const threadId=useServerAgentStore(state => state.threadIds[projectId]);
    const pending=useServerAgentStore(state => state.pending[projectId]);
    const [config,setConfig]=useState<Awaited<ReturnType<typeof getAgentConfig>>>();
    const [threads,setThreads]=useState<Array<{id:string;title:string}>>([]);
    const [thread,setThread]=useState<AgentThread>();
    const [draft,setDraft]=useState(""),[model,setModel]=useState(""),[selectedSkills,setSelectedSkills]=useState<string[]>([]),[presetsOpen,setPresetsOpen]=useState(false);
    const [busy,setBusy]=useState(false),[error,setError]=useState("");
    const [attachments,setAttachments]=useState<AgentAttachment[]>([]),[answers,setAnswers]=useState<Record<string,string>>({}),[referenceIds,setReferenceIds]=useState<string[]>([]);
    const canvasNodes=useCanvasStore(state=>state.current?.id===projectId?state.current.nodes:undefined)||[];
    const listRef=useRef<HTMLDivElement>(null),contentRef=useRef<HTMLDivElement>(null),followRef=useRef(true);
    const scrollTopRef=useRef(0);
    const [showLatest,setShowLatest]=useState(false);
    const scrollToLatest=useCallback(()=>{
        const list=listRef.current;if(!list)return;
        followRef.current=true;list.scrollTop=list.scrollHeight;scrollTopRef.current=list.scrollTop;setShowLatest(false);
    },[]);
    const trackScroll=()=>{
        const list=listRef.current;if(!list)return;
        // Delayed scroll events after content growth must not be mistaken for reading history.
        if(list.scrollHeight-list.scrollTop-list.clientHeight<=48)followRef.current=true;
        else if(list.scrollTop<scrollTopRef.current)followRef.current=false;
        scrollTopRef.current=list.scrollTop;
        setShowLatest(!followRef.current);
    };
    useEffect(()=>{
        followRef.current=true;scrollTopRef.current=0;setShowLatest(false);
        const list=listRef.current,content=contentRef.current;
        if(!open||!list||!content)return;
        let frame=0;
        const observer=new ResizeObserver(()=>{
            cancelAnimationFrame(frame);
            frame=requestAnimationFrame(()=>{if(followRef.current)scrollToLatest();});
        });
        observer.observe(list);observer.observe(content);
        return()=>{observer.disconnect();cancelAnimationFrame(frame);};
    },[open,projectId,threadId,scrollToLatest]);
    const request=useRef(0),mutating=useRef(false);
    const active=thread?.runs.find(run => run.id === thread?.activeRunId);
    const latest=active || thread?.runs.at(-1);
    const lastItem=thread?.items.at(-1),hasRejectionMessage=latest?.error==="AGENT_MODEL_REJECTED"&&lastItem?.turnId===latest.id&&lastItem?.role==="system";
    const argumentRecovery=active?.wait?.type === "tool_arguments" ? active : !active && latest?.status === "failed" && latest.error === "AGENT_INVALID_TOOL_ARGUMENTS" ? latest : undefined;
    const threadRef=useRef(threadId);threadRef.current=threadId;
    const refresh=useCallback(async (signal?:AbortSignal) => {
        const id=threadRef.current;
        if (!id) return;
        const version=++request.current;
        const snapshot=await getAgentThread(id,signal);
        if (version !== request.current || threadRef.current !== id) return;
        setThread(current=>{
            if(!current || current.id!==snapshot.id)return snapshot;
            const items=snapshot.items.map(item=>{const previous=current.items.find(old=>old.turnId===item.turnId&&old.itemId===item.itemId);return item.detail?.streaming&&previous?.detail?.streaming&&previous.text.length>item.text.length?previous:item;});
            for(const item of current.items)if(item.detail?.streaming && snapshot.runs.some(run=>run.id===item.turnId&&run.status==="running") && !items.some(next=>next.turnId===item.turnId&&next.itemId===item.itemId))items.push(item);
            return {...snapshot,items};
        });
        const held=useServerAgentStore.getState().pending[projectId];
        if (held?.threadId === id && snapshot.runs.some(run => run.submissionId === held.input.submissionId)) {useServerAgentStore.getState().hold(projectId,null);setDraft("");setAttachments([]);setReferenceIds([]);}
        // Merge external graph changes through the existing serialized persistence path.
        await flushCanvasPersistence();
        await useCanvasStore.getState().refreshProject(projectId);
    },[projectId]);
    useEffect(() => {
        if (!open) return;
        let live=true;
        Promise.all([getAgentConfig(),listAgentThreads(projectId)]).then(([next,list]) => {
            if (!live) return;
            setConfig(next);setThreads(list.threads);useServerAgentStore.setState({lastProjectId:projectId,pollIntervalMs:next.enabled?next.pollIntervalMs:undefined});
            setModel(current => next.models.includes(current) ? current : next.models[0] || "");
            if (!useServerAgentStore.getState().threadIds[projectId] && list.threads[0]) useServerAgentStore.getState().select(projectId,list.threads[0].id);
        }).catch(error => {if (live) setError(error.message);});
        return () => {live=false;};
    },[open,projectId]);
    useEffect(() => {
        request.current++;setThread(undefined);setError("");
        if (!open || !threadId) return;
        const controller=new AbortController();
        void refresh(controller.signal).catch(error => {if (!controller.signal.aborted) setError(error.message);});
        return () => controller.abort();
    },[open,threadId,refresh]);
    const polling=Boolean(active && ["queued","running","waiting_tasks"].includes(active.status));
    useEffect(() => {
        if (!open || !threadId || !polling || !config?.pollIntervalMs) return;
        const controller=new AbortController();let inFlight=false;
        const tick=async () => {
            if (document.hidden || inFlight || mutating.current) return;
            inFlight=true;
            try {await refresh(controller.signal);} catch (error) {if (!controller.signal.aborted) setError((error as Error).message);} finally {inFlight=false;}
        };
        const timer=setInterval(() => void tick(),config.pollIntervalMs);
        const visible=() => {if (!document.hidden) void tick();};
        document.addEventListener("visibilitychange",visible);
        return () => {clearInterval(timer);document.removeEventListener("visibilitychange",visible);controller.abort();};
    },[open,threadId,polling,config?.pollIntervalMs,refresh]);
    useEffect(()=>{
        if(!open||!threadId||!polling)return;
        let close:(()=>void)|undefined;
        const connect=()=>{close?.();if(document.hidden)return;close=listenAgentThread(threadId,item=>setThread(current=>{
            if(!current||current.id!==item.threadId||!current.runs.some(run=>run.id===item.turnId&&["queued","running"].includes(run.status)))return current;
            const previous=current.items.find(old=>old.turnId===item.turnId&&old.itemId===item.itemId);
            if(previous&&(!previous.detail?.streaming||previous.text.length>=item.text.length))return current;
            return {...current,items:previous?current.items.map(old=>old===previous?item:old):[...current.items,item]};
        }));};
        connect();document.addEventListener("visibilitychange",connect);
        return()=>{close?.();document.removeEventListener("visibilitychange",connect);};
    },[open,threadId,polling]);
    useEffect(()=>setAnswers({}),[threadId,active?.waitVersion]);
    const act=async (operation:() => Promise<unknown>) => {
        if (mutating.current) return;
        mutating.current=true;setBusy(true);setError("");
        try {await operation();useServerAgentStore.setState({actionWatchId:crypto.randomUUID()});await refresh();} catch (error) {setError((error as Error).message);} finally {mutating.current=false;setBusy(false);}
    };
    const createThread=async () => {
        const created=await createAgentThread(projectId,draft.trim() || "画布创作");
        useServerAgentStore.getState().select(projectId,created.id);
        setThreads((await listAgentThreads(projectId)).threads);
        return created.id;
    };
    const submit=async (id:string,input:Parameters<typeof submitAgentRun>[1]) => {
        try {return await submitAgentRun(id,input);} catch (error) {
            if (error instanceof CloudError && [400,403,404,409].includes(error.status)) useServerAgentStore.getState().hold(projectId,null);
            throw error;
        }
    };
    const startGoal=async(goal:string,selection:string[],files:AgentAttachment[],chosenModel:string,skills=selectedSkills)=>{
        if(!config?.models.includes(chosenModel))throw new Error("原推理模型当前不可用，请重新选择");
        if(config.inputCharacters && goal.length+files.reduce((sum,file)=>sum+file.title.length+(file.kind==="text"?file.text.length:0),0)>config.inputCharacters)throw new Error(`目标与附件正文合计最多 ${config.inputCharacters.toLocaleString("zh-CN")} 字符，请缩小内容，不会自动截断。`);
        await onFlush();
        const current=useCanvasStore.getState().openProject(projectId);
        if(!current)throw new Error("请先保存并打开当前画布");
        const id=threadId || await createThread();
        const input={submissionId:crypto.randomUUID(),goal,selectedNodeIds:selection,model:chosenModel,skillIds:[...skills],attachments:files,clientId:useServerAgentStore.getState().clientId,baseRevision:current.contentRevision,baseGenerationRevision:current.generationRevision};
        useServerAgentStore.getState().hold(projectId,{threadId:id,input});
        await submit(id,input);useServerAgentStore.getState().hold(projectId,null);setDraft("");setAttachments([]);setReferenceIds([]);
    };
    const send=() => void act(async () => {
        scrollToLatest();
        const held=useServerAgentStore.getState().pending[projectId];
        if(held){await submit(held.threadId,held.input);useServerAgentStore.getState().hold(projectId,null);setDraft("");setAttachments([]);setReferenceIds([]);return;}
        if(draft.trim()&&model)await startGoal(draft.trim(),[...new Set([...selectedNodeIds,...referenceIds])],[...attachments],model);
    });
    const retry=(entry:AgentThread["items"][number])=>{
        const original=thread?.items.find(item=>item.turnId===entry.turnId&&item.role==="user"),run=thread?.runs.find(run=>run.id===entry.turnId);
        if(!original||!run||active||pending)return;
        modal.confirm({title:"重新尝试这次目标？",content:"会重新请求推理模型，可能产生费用。已完成节点会复用；生成任务仍须逐批确认，不会自动重发原任务。",okText:"重新尝试",cancelText:"取消",onOk:()=>act(()=>startGoal(original.text,original.detail?.selectedNodeIds||[],original.detail?.attachments||[],run.model,original.detail?.skills?.map((skill:any)=>skill.id)||[]))});
    };
    const pasteFiles=async(files:File[])=>{
        if(busy||active||pending)return;setBusy(true);setError("");
        try{const next=[];for(const file of files)next.push(await agentFileAttachment(file));setAttachments(current=>[...current,...next]);}catch(error){setError((error as Error).message);}finally{setBusy(false);}
    };
    const answer=(action:string) => void act(async () => {scrollToLatest();const target=action === "correct_tool_arguments" ? argumentRecovery : active;if (target) {await answerAgentRun(target.id,target.waitVersion,action,draft,answers);setDraft("");}});
    const choosePreset=(preset:typeof agentPresets[number]) => {
        const apply=()=>{setDraft(preset.goal);setSelectedSkills([...preset.skills]);setPresetsOpen(false);};
        if (draft.trim() && draft!==preset.goal) modal.confirm({title:"替换当前未发送的目标？",content:"会填入所选创作方向，你可以继续修改，之后再点击发送。",okText:"替换",cancelText:"保留",onOk:apply});else apply();
    };
    if (!open) return null;
    const button="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
    const wait=active?.wait;
    const presetButtons=<div className="grid grid-cols-2 gap-1">{agentPresets.map(preset=><button key={preset.id} type="button" disabled={busy||Boolean(active)||Boolean(pending)} className={`${button} flex-col items-start py-2 text-left`} onClick={()=>choosePreset(preset)}><span className="font-medium">{preset.title}</span><span className="text-[11px]" style={{color:theme.node.muted}}>{preset.description}</span></button>)}</div>;

    return <aside aria-label="画布创作助手" className="relative flex h-full min-h-0 min-w-0 max-w-[90vw] flex-col border-l max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-[70]" style={{width,background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}>
        <div role="separator" aria-label="调整创作助手宽度" aria-orientation="vertical" aria-valuemin={AGENT_PANEL_MIN_WIDTH} aria-valuemax={AGENT_PANEL_MAX_WIDTH} aria-valuenow={width} tabIndex={0} className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 touch-none cursor-col-resize select-none focus-visible:outline focus-visible:outline-1" onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);resizeStart.current={x:event.clientX,width};}} onPointerMove={event=>{if(resizeStart.current)setWidth(resizeStart.current.width+resizeStart.current.x-event.clientX);}} onPointerUp={event=>event.currentTarget.releasePointerCapture(event.pointerId)} onLostPointerCapture={()=>{resizeStart.current=null;saveWidth();}} onKeyDown={event=>{const next=event.key==="Home"?AGENT_PANEL_MIN_WIDTH:event.key==="End"?AGENT_PANEL_MAX_WIDTH:event.key==="ArrowLeft"?width+1:event.key==="ArrowRight"?width-1:undefined;if(next!==undefined){event.preventDefault();setWidth(next);saveWidth();}}}/>
        <header className="flex h-14 shrink-0 items-center gap-2 px-4"><Bot className="size-4"/><strong className="flex-1 text-sm">创作助手</strong><CanvasServerAgentSessions disabled={busy||Boolean(pending)} onChanged={async()=>setThreads((await listAgentThreads(projectId)).threads)}/><button type="button" title="新建会话" aria-label="新建会话" disabled={busy || Boolean(pending)} className={button} onClick={() => void act(createThread)}><Plus className="size-4"/></button><button type="button" aria-label="关闭创作助手" className={button} onClick={toggle}><X className="size-4"/></button></header>
        <div className="px-4 pb-3"><Select className="w-full" variant="borderless" showSearch optionFilterProp="label" aria-label="创作会话" placeholder="新会话" value={threadId} disabled={busy || Boolean(pending)} options={threads.map(item => ({label:item.title,value:item.id}))} onChange={id => useServerAgentStore.getState().select(projectId,id)}/></div>
        {thread?.creativeState ? <details className="mx-4 mb-3 text-xs" style={{color:theme.node.muted}}><summary className="cursor-pointer">创作备忘 · {agentPhases[thread.creativeState.phase as keyof typeof agentPhases] || "待确认"}</summary><div className="space-y-1 pt-2 whitespace-pre-wrap">{thread.creativeState.brief?<p>{thread.creativeState.brief}</p>:null}{thread.creativeState.targetDurationSeconds?<p>目标时长：{thread.creativeState.targetDurationSeconds} 秒</p>:null}{thread.creativeState.approvedPlan?<p>{thread.creativeState.approvedPlan}</p>:null}</div></details> : null}
        <div ref={listRef} role="log" aria-label="助手对话" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" style={{overflowAnchor:"none"}} onScroll={trackScroll} aria-live="polite">
            <div ref={contentRef} className="space-y-4">
            {!thread?.items.length ? <div className="space-y-4 py-3"><div><p className="text-base font-medium">从一个想法开始</p><p className="mt-1 text-xs leading-6" style={{color:theme.node.muted}}>选中文本、图片或已有作品，再告诉我这次想完成什么。也可以选择一个方向开始。</p></div>{presetButtons}<p className="text-[11px]" style={{color:theme.node.muted}}>选择方向只填入目标，生成媒体前仍会展示具体确认。</p></div> : null}
            <CanvasServerAgentTimeline items={thread?.items||[]} onFocusNode={onFocusNode} onRetry={!active&&!pending&&!busy?retry:undefined}/>
            {latest ? <div className="border-t pt-3 text-[11px] leading-5" style={{color:theme.node.muted,borderColor:theme.node.stroke}}>{["queued","running","waiting_tasks"].includes(latest.status) ? <Spin size="small" className="mr-2"/> : null}{statuses[latest.status]} · {latest.decisionCount} 次模型调用 · {latest.tokenCount.toLocaleString("zh-CN")} token{latest.errorMessage && !hasRejectionMessage ? <p className="mt-2">{latest.errorMessage}</p> : null}</div> : null}
            {argumentRecovery ? <div className="space-y-2 text-xs"><p>修正并继续会再次请求推理模型。</p><details><summary className="cursor-pointer">查看参数问题</summary>{argumentRecovery.wait?.errors?.map((error:any) => <div className="mt-2" key={error.callId}>{actions[error.toolName] || "工具参数"}{error.problems.map((problem:any,index:number) => <p key={index} className="break-words">{problem.field}：{problem.message}</p>)}{error.hint ? <p>{error.hint}</p> : null}</div>)}</details><Button size="small" disabled={busy || Boolean(pending)} onClick={() => answer("correct_tool_arguments")}>修正参数并继续</Button></div> : null}
            {wait?.questions?.length?<div className="space-y-5">{wait.questions.map((question:any)=><fieldset key={question.id} className="min-w-0 space-y-2 text-xs"><legend className="mb-2 text-[13px] leading-6">{question.question}</legend>{question.options?.length?<Radio.Group className="w-full" aria-label={question.question} value={answers[question.id]} disabled={busy} onChange={event=>setAnswers(current=>({...current,[question.id]:event.target.value}))}><div className="space-y-1">{question.options.map((option:any)=><Radio key={option.label} value={option.label} className="!m-0 !flex items-start rounded-md px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10"><span className="block text-xs leading-5">{option.label}</span>{option.description?<span className="block text-[11px] leading-5" style={{color:theme.node.muted}}>{option.description}</span>:null}</Radio>)}</div></Radio.Group>:null}<Input.TextArea style={{background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke}} aria-label={question.question} autoSize={{minRows:1,maxRows:4}} value={answers[question.id]||""} disabled={busy} placeholder="也可以直接填写或补充答案" onChange={event=>setAnswers(current=>({...current,[question.id]:event.target.value}))}/></fieldset>)}</div>:null}
            {wait?.question && !argumentRecovery ? <p className="whitespace-pre-wrap text-sm leading-6">{wait.question}</p> : null}
            {active?.status === "waiting_confirmation"&&wait?.type === "workbench"?<div className="space-y-3 text-xs"><strong>确认工作台{wait.manifest.kind==="image"?"图片":"视频"}生成 · {wait.manifest.count} 项</strong><p>{wait.manifest.model}</p><p className="whitespace-pre-wrap leading-6">{wait.manifest.prompt}</p><p>{Object.entries(wait.manifest.parameters).map(([key,value])=>`${parameterLabels[key]||key}：${value}`).join(" · ")}</p><p>参考素材 {wait.manifest.references.length} 项</p>{wait.manifest.references.map((url:string)=><a key={url} className="mr-2 underline" href={url} target="_blank" rel="noreferrer">查看素材</a>)}<details><summary className="cursor-pointer">查看实际请求参数</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify(wait.manifest.request,null,2)}</pre></details>{wait.pricing?.models?.filter((price:any)=>price.model===wait.manifest.model).map((price:any)=><div key={price.model}>{price.model} · {wait.pricing.currency}{price.tiers?.map((tier:any,index:number)=><p key={index}>{tier.condition} {tier.metrics.map((metric:any)=>`${metric.label} ${metric.minAmount}${metric.maxAmount!==metric.minAmount?`–${metric.maxAmount}`:""}/${metric.unitLabel}`).join("；")}</p>)}{price.note}</div>)}<p style={{color:theme.node.muted}}>确认后在后台受理以上独立请求，结果以实际任务为准。媒体可能计费，不会自动补生成；工作台再次点击生成属于新的请求。</p><div className="flex gap-2"><Button size="small" disabled={busy} onClick={()=>void act(()=>confirmAgentRun(active.id,active.waitVersion,true))}>确认生成</Button><Button size="small" type="text" disabled={busy} onClick={()=>void act(()=>confirmAgentRun(active.id,active.waitVersion,false))}>拒绝</Button></div></div>:null}
            {active?.status === "waiting_confirmation" && wait?.type === "media" ? <div className="space-y-3 text-xs"><p className="font-medium">确认以下生成范围</p>{wait.manifest.nodes.map((node:any) => <div key={node.id} className="space-y-1 border-l pl-3" style={{borderColor:theme.node.stroke}}><strong>{nodeLabels[node.kind] || "生成"} · {node.title} · {node.taskId ? "复用原任务" : "1 项"}</strong><div>{node.parameters.model}</div><div className="whitespace-pre-wrap">{node.prompt}</div><div>{Object.entries(node.parameters).filter(([key]) => key !== "model").map(([key,value]) => `${parameterLabels[key] || key}：${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ")}</div><div>参考素材 {node.references.length} 项</div>{node.references.map((url:string) => <a className="mr-2 underline" key={url} href={url} target="_blank" rel="noreferrer">查看素材</a>)}</div>)}
                {wait.pricing?.models?.filter((price:any) => wait.manifest.nodes.some((node:any) => node.parameters.model === price.model)).map((price:any) => <div key={price.model}>{price.model} · {wait.pricing.currency}{price.tiers?.map((tier:any,index:number) => <p key={index}>{tier.condition} {tier.metrics.map((metric:any) => `${metric.label} ${metric.minAmount}${metric.maxAmount !== metric.minAmount ? `–${metric.maxAmount}` : ""}/${metric.unitLabel}`).join("；")}</p>)}{price.note}</div>)}
                {wait.manifest.nodes.some((node:any)=>node.kind==="text")?<p style={{color:theme.node.muted}}>文本任务是独立模型请求，也可能计费；结果写入新输出节点，原正文保留。标为复用的任务不会再次请求模型。</p>:null}
                <p style={{color:theme.node.muted}}>金额以实际账单为准。每项为一次创作请求，模型可能返回多个版本。确认只覆盖本批节点、参数和素材；再次生成须重新确认。</p><div className="flex gap-2"><Button size="small" disabled={busy} onClick={() => void act(() => confirmAgentRun(active.id,active.waitVersion,true))}>确认生成</Button><Button size="small" type="text" disabled={busy} onClick={() => void act(() => confirmAgentRun(active.id,active.waitVersion,false))}>拒绝</Button></div></div> : null}
            {active?.status === "waiting_confirmation" && wait?.type === "canvas_edit" ? <div className="space-y-3 text-xs"><strong>确认本批画布修改</strong><p>{actions[wait.manifest.action] || "调整画布"}</p>{wait.manifest.nodes.map((node:any)=><div key={node.id} className="space-y-1"><button type="button" className={button} onClick={()=>{const target=useCanvasStore.getState().nodes.find(item=>item.id===node.id||(item as any).entityId===node.id);if(target)onFocusNode(target.id);}}>{node.change} · {node.title || nodeLabels[node.type]}</button>{node.change==="改名"||node.change==="修改正文"?<p>标题：{node.nextTitle}</p>:null}{node.change==="修改正文"?<div className="space-y-2"><details open><summary className="cursor-pointer">修改前</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words py-2 text-xs leading-5">{node.beforeContent}</pre></details><details open><summary className="cursor-pointer">修改后</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words py-2 text-xs leading-5">{node.nextContent}</pre></details></div>:null}{node.nextSize?<p>{node.beforeSize.width} × {node.beforeSize.height} → {node.nextSize.width} × {node.nextSize.height}</p>:null}{node.change==="移动"?<p>位置：{node.position.x}, {node.position.y} → {node.nextPosition.x}, {node.nextPosition.y}</p>:null}</div>)}{wait.manifest.connections.map((edge:any)=><p key={edge.id}>移除连线：{edge.fromTitle || "节点"} → {edge.toTitle || "节点"}</p>)}<p style={{color:theme.node.muted}}>确认仅覆盖这批对象；画布变化后需要重新核对。删除画布节点不取消后台任务，作品仍保留。</p><div className="flex gap-2"><Button size="small" danger={wait.manifest.action.startsWith("delete_")} disabled={busy} onClick={()=>void act(()=>confirmAgentRun(active.id,active.waitVersion,true))}>确认修改</Button><Button size="small" type="text" disabled={busy} onClick={()=>void act(()=>confirmAgentRun(active.id,active.waitVersion,false))}>拒绝</Button></div></div> : null}
            {wait?.type === "task_failure" ? <div className="space-y-2 text-xs">{wait.tasks.map((task:any) => <p key={task.id}>{task.id}：{taskLabels[task.status] || "待处理"}</p>)}<button type="button" disabled={busy} className={button} onClick={() => answer("resume_tasks")}>查询 / 恢复原任务</button>{wait.tasks.some((task:any) => task.status === "succeeded") ? <button type="button" disabled={busy} className={button} onClick={() => answer("continue_successes")}>使用成功项继续</button> : null}</div> : null}
            {["compaction_failed","context_limit"].includes(wait?.type) ? <Button size="small" disabled={busy} onClick={() => answer("retry_compaction")}>{wait?.type === "compaction_failed" ? "重试历史压缩" : "压缩历史并继续"}</Button> : null}
            {wait?.type === "budget" ? <Button size="small" disabled={busy} onClick={() => answer("continue_budget")}>继续下一段预算</Button> : null}
            {wait?.type === "conflict" ? <Button size="small" disabled={busy} onClick={() => answer("refresh")}>使用当前画布重新决策</Button> : null}
            {wait?.type === "authorization" ? <div className="space-y-2">{wait.recovery !== "service" ? <Link className="text-xs underline" to="/config">检查模型服务授权</Link> : <p>服务恢复后可继续原运行，已有成果保留。</p>}<Button size="small" disabled={busy} onClick={() => answer("retry_authorization")}>{wait.recovery === "service" ? "检查服务并继续" : "重新检查并继续"}</Button></div> : null}
            </div>
        </div>
        <footer onDragOver={event=>{if(event.dataTransfer.types.includes("Files"))event.preventDefault();}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();void pasteFiles(Array.from(event.dataTransfer.files));}}} className="space-y-2 border-t p-3" style={{borderColor:theme.node.stroke}}>
            {error ? <p role="alert" className="text-xs leading-5">{error}</p> : null}
            {pending ? <p className="text-xs">原提交尚未确认。已保留提交标识，请查询原会话或使用同一提交重试。</p> : null}
            <div className="flex items-center gap-2 text-xs" style={{color:theme.node.muted}}><span className="flex-1">固定提交时选区 · 当前 {selectedNodeIds.length} 项</span>{showLatest ? <button type="button" className={`${button} shrink-0`} onClick={scrollToLatest}><ArrowDown className="size-3"/>回到最新</button> : null}{active ? <button type="button" className={button} disabled={busy} onClick={() => void act(() => cancelAgentRun(active.id))}><Square className="size-3"/>停止助手</button> : null}</div>
            {!wait?.questions?.length?<><CanvasServerAgentAttachments value={attachments} onChange={setAttachments} disabled={busy||Boolean(active)||Boolean(pending)} inputCharacters={config?.inputCharacters} onBusyChange={setBusy}/>
            {attachments.some(file=>file.kind==="image")&&!config?.imageModels.includes(model)?<p className="text-[11px] leading-5" style={{color:theme.node.muted}}>当前推理模型不能读取图片画面；附件仍可作为生成参考，不会自动换模型。</p>:null}
            <Select mode="multiple" size="small" variant="borderless" className="w-full" aria-label="引用画布节点" placeholder="添加画布节点引用" value={referenceIds} disabled={busy||Boolean(active)||Boolean(pending)} optionFilterProp="label" options={canvasNodes.map(node=>({value:node.id,label:node.title||nodeLabels[node.type]||"未命名节点"}))} onChange={setReferenceIds}/></>:null}
            <div className="rounded-xl border px-2 py-2" style={{borderColor:theme.node.stroke}}>
                {wait?.questions?.length?<p className="px-2 py-1 text-xs leading-5" style={{color:theme.node.muted}}>请完成上方各项选择或填写答案，再点击回复。</p>:<Input.TextArea onPaste={event=>{if(event.clipboardData.files.length){event.preventDefault();void pasteFiles(Array.from(event.clipboardData.files));}}} variant="borderless" aria-label="创作目标或补充信息" autoSize={{minRows:2,maxRows:6}} value={draft} disabled={busy || Boolean(pending) || Boolean(active && wait?.type !== "question")} onChange={event => setDraft(event.target.value)} placeholder={wait?.type === "question" ? "补充所需信息" : "告诉我这次要完成什么…"}/>}
                <div className="mt-1 flex min-w-0 items-center gap-1">
                    <CanvasServerAgentSkills value={selectedSkills} onChange={setSelectedSkills} disabled={busy||Boolean(active)||Boolean(pending)}/>
                    <Popover trigger="click" placement="topLeft" open={presetsOpen} onOpenChange={setPresetsOpen} content={<div className="w-72 max-w-[75vw]" style={{color:theme.node.text}}>{presetButtons}</div>}><button type="button" title="选择创作方向" aria-label="创作方向" className={`${button} shrink-0`} disabled={busy||Boolean(active)||Boolean(pending)}><Sparkles className="size-3.5"/>方向</button></Popover>
                    {!active ? <Select className="min-w-0 flex-1" size="small" variant="borderless" aria-label="助手推理模型" placeholder="推理模型" value={model || undefined} options={config?.models.map(value => ({label:value,value}))} onChange={setModel} disabled={busy || Boolean(pending)}/> : <span className="min-w-0 flex-1 truncate px-1 text-[11px]" style={{color:theme.node.muted}} title={active.model}>{active.model}</span>}
                    {wait?.type === "question" ? <Button size="small" type="primary" disabled={busy || (wait.questions?.length?wait.questions.some((question:any)=>!answers[question.id]?.trim()):!draft.trim())} onClick={() => answer("reply")}>回复</Button> : !active ? <Button size="small" type="primary" aria-label={pending?"同一提交重试":"发送"} icon={<Send className="size-3.5"/>} disabled={busy || !config?.enabled || !pending && (!draft.trim() || !model)} onClick={send}>{pending ? "重试" : null}</Button> : null}
                </div>
            </div>
            <p className="text-[11px] leading-4" style={{color:theme.node.muted}}>推理可能计费 · 关闭面板不会停止后台运行</p>
            {pending ? <button type="button" disabled={busy} className={button} onClick={() => void act(() => refresh())}>查询原提交</button> : null}
        </footer>
    </aside>;
}
