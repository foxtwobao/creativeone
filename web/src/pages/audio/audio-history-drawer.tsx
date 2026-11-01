import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Empty, Input, Pagination, Tag } from "antd";
import { ArrowLeft, Headphones, PenLine, RefreshCw, Search } from "lucide-react";
import { useAudioTask } from "@/hooks/use-audio-task";
import { cloudSession } from "@/services/api/cloud";
import { fetchWorks, type Task } from "@/services/api/tasks";
import { generationPrompt } from "../../../../shared/generation-request";
import { mergeWorks, taskLabels } from "../../../../shared/works";
import { AudioWorkCard } from "./audio-work-card";

export function AudioHistoryDrawer({ onClose, onEdit, canEdit }: { onClose: () => void; onEdit: (id: string) => void; canEdit: boolean }) {
    const { modal, message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [previewId, setPreviewId] = useState<string>();
    const query = useQuery({ queryKey: ["audio-history", cloudSession?.user.id, page, keyword], queryFn: ({ signal }) => fetchWorks(new URLSearchParams({ view: "tasks", kind: "audio", page: String(page), pageSize: "10", keyword }), signal), refetchOnMount: "always" });
    const { task, loading, error, load } = useAudioTask(previewId);
    const preview = task ? mergeWorks([], [task])[0] : undefined;
    const edit = (task: Task) => {
        if (!canEdit) return;
        const open = () => onEdit(task.id);
        if (task.status === "unknown") modal.confirm({ title: "继续创作？", content: "原任务结果或计费可能尚未确认；再次生成将创建新任务，可能重复计费。", okText: "继续创作", cancelText: "取消", onOk: open });
        else open();
    };
    return <Drawer title="生成记录" extra={<span className="text-xs text-muted-foreground">共 {query.data?.total || 0} 条</span>} placement="right" size="min(640px, 100vw)" styles={{ body: { padding: 16 } }} open onClose={onClose}>
        {previewId ? <div>
            <div className="mb-4 flex items-center justify-between gap-2 border-b border-border pb-4">
                <Button type="text" className="!h-9 !px-1 !text-xs !text-muted-foreground" icon={<ArrowLeft size={14} />} onClick={() => setPreviewId(undefined)}>返回记录</Button>
                <div className="flex gap-1"><Button type="text" size="small" loading={loading} icon={<RefreshCw size={14} />} onClick={() => void load().catch((error) => message.error(error.message))}>刷新</Button><Button type="primary" className="!h-9 !rounded-full !px-4 !text-xs !font-medium !shadow-none" icon={<PenLine size={13} />} title="将这条记录的文案和参数带回编辑区" disabled={!canEdit || !task?.request?.audio_input} onClick={() => task && edit(task)}>继续创作</Button></div>
            </div>
            {!canEdit ? <p className="text-xs text-muted-foreground">请先确认当前提交结果，再继续其他创作。</p> : null}
            {error ? <Alert className="mb-3" type="warning" title={error} /> : null}
            {preview ? <AudioWorkCard key={preview.id} work={preview} onRefresh={load} readOnly /> : loading ? <p role="status" className="text-sm text-muted-foreground">正在读取音频结果…</p> : null}
        </div> : <>
            <div className="mb-3 flex items-center gap-2"><Input prefix={<Search size={16} />} placeholder="搜索创作记录" aria-label="搜索创作记录" allowClear value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} /><Button type="text" aria-label="刷新记录" icon={<RefreshCw size={14} />} loading={query.isFetching} onClick={() => void query.refetch()} /></div>
            {query.error ? <Alert className="mb-3" type="warning" title={query.error.message} /> : null}
            {query.isPending ? <p role="status" className="text-sm text-muted-foreground">正在加载创作记录…</p> : query.data?.works.length ? <div className="space-y-2">{query.data.works.map((work) => <button key={work.id} type="button" className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left hover:bg-muted/50" onClick={() => setPreviewId(work.task!.id)}>
                <Headphones size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1"><p className="!mb-1 truncate text-sm font-medium">{work.task?.title || generationPrompt(work.task?.request).slice(0, 48) || "未命名音频"}</p><p className="!mb-0 truncate text-xs text-muted-foreground">{work.task?.model} · {new Date(work.createdAt).toLocaleString("zh-CN")}</p></div>
                <Tag className="!m-0 shrink-0" color={work.state === "attention" ? "warning" : work.state === "processing" ? "processing" : "default"}>{taskLabels[work.task!.status]}</Tag>
            </button>)}</div> : !query.error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无创作记录" /> : null}
            {(query.data?.total || 0) > 10 ? <Pagination className="mt-4" align="center" size="small" current={page} pageSize={10} total={query.data?.total} showSizeChanger={false} onChange={setPage} /> : null}
        </>}
    </Drawer>;
}
