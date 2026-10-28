import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Descriptions, Input, Modal, Tag } from "antd";
import { Download, Heart, Music2, PencilLine, RotateCcw } from "lucide-react";
import { AudioPlayer } from "@/components/audio-player";
import { useDownloadFile } from "@/hooks/use-download-file";
import { useAssetStore } from "@/stores/use-asset-store";
import { fetchTask, renameTask, resumeTaskResult, removeTaskFromWorks } from "@/services/api/tasks";
import { taskMedia, assetMedia, taskLabels, type Work } from "../../../../shared/works";
import { taskSettings } from "../../../../shared/task-settings";
import { generationPrompt } from "../../../../shared/generation-request";

export function AudioWorkCard({ work, onRefresh, onCanvas }: { work: Work; onRefresh: () => Promise<void>; onCanvas: (work: Work) => void }) {
    const task = work.task;
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const download = useDownloadFile();
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [details, setDetails] = useState(false);
    const name = task?.title || work.asset?.title || (task ? generationPrompt(task.request).slice(0, 24) || task.model : "未命名音频");
    const versionNumber = (url: string, index: number) => (task?.result?.audios?.findIndex((item) => item.file?.url === url) ?? index) + 1;
    const media = task ? taskMedia(task) : assetMedia(work.asset!);
    const action = async (run: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        try { await run(); await onRefresh(); }
        catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
        finally { setBusy(false); }
    };
    const favorite = async (index: number) => {
        const file = media[index];
        if (!file.storageKey) throw new Error("文件尚未保存成功");
        await useAssetStore.getState().addAsset({ kind: "audio", title: name, coverUrl: "", tags: [], source: "音频创作", metadata: { taskId: task!.id, sourceUrl: file.url }, data: { url: file.url, storageKey: file.storageKey, width: 0, height: 0, bytes: file.bytes || 0, mimeType: file.mimeType || "audio/mp4", durationMs: file.durationMs } });
        message.success("已收藏到我的作品");
    };
    const reuse = () => {
        const open = () => navigate(`/audio?task=${task!.id}`);
        if (task?.status === "unknown") modal.confirm({ title: "再次创作？", content: "原任务结果或计费可能尚未确认；再次生成将创建新任务，可能重复计费。", okText: "复用参数", cancelText: "取消", onOk: open });
        else open();
    };
    return <article className="rounded-2xl border border-border/70 bg-card p-5">
        <div className="flex items-start gap-3">
            <Music2 className="mt-1 size-5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <div className="min-w-0 flex-1"><h3 className="!mb-0 truncate text-sm font-medium" title={name}>{name}</h3><p className="!mb-0 mt-1 text-xs text-muted-foreground">{task?.model || (work.source === "generated" ? "收藏音频" : "上传音频")} · {new Date(work.createdAt).toLocaleString("zh-CN")}</p></div>
            {task ? <Tag className="!m-0" color={task.status === "unknown" ? "warning" : task.status === "failed" ? "error" : work.state === "processing" ? "processing" : "default"}>{taskLabels[task.status]}</Tag> : null}
        </div>
        {task?.error_message ? <p className="!mb-0 mt-3 text-xs leading-5 text-muted-foreground">{task.error_message}</p> : null}
        <div className="mt-4 divide-y divide-border/60">{media.map((file, index) => <div key={file.url} className="space-y-2 py-3 first:pt-0">
            <div className="flex items-center justify-between text-xs text-muted-foreground"><span>版本 {versionNumber(file.url, index)}</span><span>{file.durationMs ? `${(file.durationMs / 1000).toFixed(1)} 秒 · ` : ""}{file.format?.toUpperCase() || file.mimeType}</span></div>
            <AudioPlayer key={file.url} url={file.url} />
            <div className="flex flex-wrap gap-1">
                <Button size="small" type="text" icon={<Download size={14} />} onClick={() => void download(file.url, `${name}${media.length > 1 ? `-${index + 1}` : ""}.${file.format || (file.mimeType?.includes("wav") ? "wav" : file.mimeType?.includes("mpeg") ? "mp3" : file.mimeType?.includes("mp4") ? "m4a" : file.mimeType?.split("/")[1] || "audio")}`)}>下载</Button>
                {task ? <Button size="small" type="text" disabled={busy || work.assets.some((asset) => asset.kind === "audio" && asset.data.storageKey === file.storageKey)} icon={<Heart size={14} />} onClick={() => void action(() => favorite(index))}>{work.assets.some((asset) => asset.kind === "audio" && asset.data.storageKey === file.storageKey) ? "已收藏" : "收藏"}</Button> : null}
                <Button size="small" type="text" onClick={() => onCanvas(task ? { ...work, task: { ...task, result: { audios: [{ file: file as import("../../../../shared/audio").AudioFile }], defaultIndex: 0 } } } : work)}>添加到画布</Button>
            </div>
        </div>)}</div>
        {task?.result?.audios?.map((item, index) => !item.file ? <p key={index} className="mt-2 text-xs text-muted-foreground">版本 {index + 1} 尚未保存：{item.error === "MEDIA_HOST_NOT_ALLOWED" ? "下载域名尚未获准，请联系管理员" : "文件下载或验证失败，可恢复保存；临时链接失效后可能无法恢复"}</p> : null)}
        <div className="mt-3 flex flex-wrap gap-1 border-t border-border/60 pt-3">
            <Button size="small" type="text" icon={<PencilLine size={14} />} disabled={busy} onClick={() => { setTitle(name); setEditing(true); }}>改名</Button>
            {task?.request?.audio_input ? <Button size="small" type="text" icon={<RotateCcw size={14} />} onClick={reuse}>再次创作</Button> : null}
            {task?.status === "unknown" && task.error === "AUDIO_SAVE_INCOMPLETE" ? <Button size="small" type="text" loading={busy} onClick={() => void action(async () => {
                const current = await fetchTask(task.id);
                if (!current.result_available) throw new Error("当前没有可恢复的完整响应");
                await resumeTaskResult(task.id); message.info("已开始恢复保存，未重新调用模型");
            })}>恢复保存</Button> : null}
            {task ? <Button size="small" type="text" onClick={() => setDetails(!details)}>任务详情</Button> : null}
            {!task || ["succeeded", "failed", "cancelled", "expired"].includes(task.status) ? <Button size="small" type="text" disabled={busy} onClick={() => modal.confirm({ title: "移除此作品？", content: "仍被任务、收藏或画布引用的文件会保留。", okText: "移除", cancelText: "取消", onOk: () => action(() => task ? removeTaskFromWorks(task.id) : useAssetStore.getState().removeAsset(work.asset!.id)) })}>移除</Button> : null}
        </div>
        {details && task ? <div className="mt-3 space-y-2 text-xs text-muted-foreground"><p className="whitespace-pre-wrap break-words">{generationPrompt(task.request)}</p><Descriptions size="small" column={1} items={taskSettings({ audio_input: task.request?.audio_input })} /><p>任务 ID：{task.id}</p></div> : null}
        <Modal title="作品名称" open={editing} confirmLoading={busy} onCancel={() => setEditing(false)} okText="保存" cancelText="取消" onOk={() => void action(async () => {
            if (!title.trim()) throw new Error("请输入作品名称");
            if (task) await renameTask(task.id, title); else await useAssetStore.getState().updateAsset(work.asset!.id, { title: title.trim() });
            setEditing(false); message.success("名称已保存");
        })}><Input aria-label="作品名称" value={title} onChange={(event) => setTitle(event.target.value)} /></Modal>
    </article>;
}
