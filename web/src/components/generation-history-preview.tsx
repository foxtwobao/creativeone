import { ArrowLeft, PenLine } from "lucide-react";
import { Button, Image, Tag } from "antd";

export type HistoryPreviewRecord = {
    title: string;
    model: string;
    prompt: string;
    status: "pending" | "success" | "failed";
    parameters: string;
    error?: string;
    images?: { id: string; url: string; thumbnail: string }[];
    video?: string;
    references?: { id: string; url: string; thumbnail: string }[];
};

export function GenerationHistoryPreview({ record, onBack, onEdit }: { record: HistoryPreviewRecord; onBack: () => void; onEdit: () => void }) {
    const hasResult = Boolean(record.images?.length || record.video);
    return <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-border pb-4"><Button type="text" className="!h-9 !px-1 !text-xs !text-muted-foreground" icon={<ArrowLeft size={14} />} onClick={onBack}>返回记录</Button><Button type="primary" className="!h-9 !rounded-full !px-4 !text-xs !font-medium !shadow-none" icon={<PenLine size={13} />} title="将这条记录的提示词、参考素材和参数带回编辑区" onClick={onEdit}>继续创作</Button></div>
        <div><div className="flex items-start justify-between gap-3"><h2 className="min-w-0 break-words text-sm font-semibold">{record.title}</h2><Tag className="!m-0 shrink-0" color={record.status === "failed" ? "error" : record.status === "pending" ? "processing" : "success"}>{record.status === "failed" ? "失败" : record.status === "pending" ? "未完成" : "已完成"}</Tag></div><p className="mt-1 break-words text-xs text-muted-foreground">{record.model} · {record.parameters}</p></div>
        {record.video ? <video src={record.video} controls preload="none" className="max-h-[50vh] w-full rounded-xl bg-black object-contain" /> : null}
        {record.images?.length ? <Image.PreviewGroup><div className="grid grid-cols-2 gap-2">{record.images.map((item, index) => <Image key={item.id} src={item.thumbnail} alt={`生成图片 ${index + 1}`} preview={{ src: item.url }} className="!aspect-square !w-full rounded-lg object-contain" />)}</div></Image.PreviewGroup> : null}
        {!hasResult ? <p className="rounded-xl border border-border p-4 text-xs text-muted-foreground">该记录暂无可预览的生成结果。</p> : null}
        {record.error ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{record.error}</p> : null}
        <section><h3 className="mb-2 text-xs font-medium">提示词</h3><p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-accent/40 p-3 text-sm leading-6">{record.prompt || "无提示词"}</p></section>
        {record.references?.length ? <section><h3 className="mb-2 text-xs font-medium">参考图片</h3><Image.PreviewGroup><div className="flex flex-wrap gap-2">{record.references.map((item, index) => <Image key={item.id} width={72} height={72} src={item.thumbnail} alt={`参考图片 ${index + 1}`} preview={{ src: item.url }} className="rounded-lg object-cover" />)}</div></Image.PreviewGroup></section> : null}
    </div>;
}
