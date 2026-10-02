import { App, Button, Card, Descriptions, Drawer, Image, Tag } from "antd";
import { FileText, Film, ImageIcon, LoaderCircle, Music2 } from "lucide-react";
import { useState } from "react";
import { useCloudStore } from "@/stores/use-cloud-store";
import { queryVideoTask } from "@/services/api/tasks";
import { useCopyText } from "@/hooks/use-copy-text";
import type { Asset } from "@/stores/use-asset-store";
import { imagePreviewUrl } from "@/services/image-storage";
import { features } from "@/constant/features";
import { taskLabels, taskMedia, workKinds, type Work } from "./works";
import { generationPrompt, generationRequestPrompt } from "../../../../shared/generation-request";
import { taskSettings } from "./task-details";

export function TaskCard({ work, onRefresh, onRemove, onEdit, onCanvas, compact = false }: { compact?: boolean; work: Work; onRefresh: () => Promise<void>; onRemove: () => void; onEdit: (asset: Asset) => void; onCanvas: () => void }) {
    const task = work.task!;
    const { message } = App.useApp();
    const authorize = useCloudStore((state) => state.setModelLoginRequired);
    const copyText = useCopyText();
    const [open, setOpen] = useState(false);
    const [resuming, setResuming] = useState(false);
    const media = taskMedia(task);
    const request = task.request || {};
    const prompt = generationPrompt(request);
    const sentPrompt = generationRequestPrompt(request);
    const settings = taskSettings(request);
    const Icon = { image: ImageIcon, video: Film, audio: Music2, text: FileText }[work.kind] || FileText;
    const resume = async () => {
        setResuming(true);
        try { await queryVideoTask(task, true); await onRefresh(); message.success("已恢复后台处理"); }
        catch (error) { message.error(error instanceof Error ? error.message : "恢复失败"); }
        finally { setResuming(false); }
    };
    return <>
        <Card styles={{ body: { padding: 0 } }} className={compact ? "overflow-hidden" : "h-full overflow-hidden"}>
            {!compact ? <button className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted/30 text-muted-foreground" onClick={() => setOpen(true)} aria-label={`查看 ${task.model}`}>
                {work.kind === "image" && media[0] ? <img src={imagePreviewUrl(media[0].url)} alt={task.model} loading="lazy" className="size-full object-cover" /> : work.state === "processing" ? <LoaderCircle size={32} className="animate-spin" /> : <Icon size={36} strokeWidth={1.3} />}
            </button> : null}
            <div className={compact ? "flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6" : "space-y-3 p-4"}>
                <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center justify-between gap-2"><Tag className="!m-0">{workKinds[work.kind]}</Tag><Tag color={task.status === "failed" ? "error" : task.status === "unknown" ? "warning" : work.state === "processing" ? "processing" : "default"}>{taskLabels[task.status] || task.status}</Tag></div>
                <h2 className="truncate text-sm font-medium" title={task.model}>{work.assets[0]?.title || task.model}</h2>
                {compact && prompt ? <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm">{prompt}</p> : null}
                <p className="text-xs text-muted-foreground">{!compact ? "AI 生成 · " : ""}{new Date(task.created_at).toLocaleString()}{work.state === "processing" ? ` · 已等待 ${Math.max(0, Math.floor((Date.now() - Date.parse(task.created_at)) / 60000))} 分钟` : ""}</p>
                {work.state === "attention" ? <p className="break-words text-xs text-muted-foreground">{task.error_message || "请查看详情处理此任务"}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-80">
                    <Button size="small" onClick={() => setOpen(true)}>{compact ? "任务详情" : "查看"}</Button>
                    {!compact && work.state === "completed" && media.length === 1 ? <Button size="small" href={media[0].url} download>下载</Button> : null}
                    {!compact && work.state === "completed" && features.canvas && (media.length || task.result?.text) ? <Button size="small" onClick={onCanvas}>添加到画布</Button> : null}
                    {task.error === "APP_USER_AUTHORIZATION_REQUIRED" ? <Button size="small" onClick={() => authorize(true)}>授权模型服务</Button> : null}
                    {task.capability === "video" && task.upstream_id && task.status === "unknown" ? <Button size="small" loading={resuming} onClick={() => void resume()}>恢复后台处理</Button> : null}
                    {["succeeded", "failed", "cancelled", "expired"].includes(task.status) ? <Button size="small" type="text" onClick={onRemove}>移除</Button> : null}
                </div>
            </div>
        </Card>
        <Drawer title={work.assets[0]?.title || task.model} open={open} onClose={() => setOpen(false)} size="large">
            <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{taskLabels[task.status] || task.status} · {task.model}</p>
                {!task.request ? <p className="text-sm text-muted-foreground">此任务创建时未记录提示词和设定。</p> : <>
                    <section><h3 className="mb-2 font-medium">生成提示词</h3>{prompt ? <><p className="whitespace-pre-wrap break-words">{prompt}</p><Button size="small" className="mt-2" onClick={() => copyText(prompt)}>复制提示词</Button></> : <p className="text-sm text-muted-foreground">未记录提示词</p>}</section>
                    {sentPrompt && sentPrompt !== prompt ? <details className="text-sm"><summary>实际发送的提示词</summary><p className="mt-2 whitespace-pre-wrap break-words">{sentPrompt}</p></details> : null}
                    <section><h3 className="mb-2 font-medium">生成设定</h3>{settings.length ? <Descriptions size="small" column={1} items={settings} /> : <p className="text-sm text-muted-foreground">未记录其他设定</p>}</section>
                </>}
                {task.error ? <><p>{task.error_message}</p><details className="text-xs text-muted-foreground"><summary>错误详情</summary><p>错误码：{task.error}<br />任务 ID：{task.id}</p></details></> : null}
                {task.result?.text ? <><p className="whitespace-pre-wrap">{task.result.text}</p><Button onClick={() => copyText(task.result!.text!)}>复制文本</Button></> : null}
                <Image.PreviewGroup>{media.map((item, index) => <div key={item.url} className="mb-4 space-y-2">
                    {work.kind === "video" ? <video src={item.url} controls preload="none" className="w-full rounded-lg" /> : work.kind === "audio" ? <audio src={item.url} controls preload="none" className="w-full" /> : <Image src={imagePreviewUrl(item.url)} preview={{ src: item.url }} alt={`${task.model} ${index + 1}`} />}
                    <Button href={item.url} download>下载{media.length > 1 ? ` ${index + 1}` : ""}</Button>
                </div>)}</Image.PreviewGroup>
                {work.assets.filter((asset) => asset.kind !== "video").map((asset) => <Button key={asset.id} onClick={() => onEdit(asset)}>编辑：{asset.title}</Button>)}
            </div>
        </Drawer>
    </>;
}
