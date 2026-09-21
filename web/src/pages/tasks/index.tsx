import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Empty, Image, Tag } from "antd";
import { cloudApi } from "@/services/api/cloud";

type Task = { id: string; channel_id: string; upstream_id?: string; model: string; capability: string; status: string; result?: { text?: string; url?: string; data?: { url?: string }[] }; error?: string; error_message?: string; created_at: string };
const labels: Record<string, string> = { running: "生成中", pending: "等待完成", succeeded: "已完成", failed: "失败", unknown: "结果待确认" };
export default function TasksPage() {
    const { message } = App.useApp();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [error, setError] = useState("");
    const load = async () => {
        try { setTasks((await cloudApi<{ tasks: Task[] }>("/tasks")).tasks); setError(""); }
        catch (error) { setError(error instanceof Error ? error.message : "加载失败"); }
    };
    useEffect(() => { void load(); }, []);
    const refreshVideo = async (task: Task) => {
        try { await cloudApi(`/ai/${task.channel_id}/v1/videos/${task.upstream_id}`); await load(); }
        catch (error) { message.error(error instanceof Error ? error.message : "查询失败"); }
    };
    return <main className="h-full overflow-auto bg-background p-6"><div className="mx-auto max-w-5xl space-y-4">
        <div className="flex justify-between"><h1 className="text-xl font-semibold">云端生成任务</h1><Button onClick={() => void load()}>刷新</Button></div>
        <p className="text-sm text-muted-foreground">查看本账号在不同设备发起的任务。结果不确定时不会自动重发，避免重复计费。</p>
        {error ? <Alert type="error" title={error} /> : null}
        {!tasks.length && !error ? <Empty description="暂无云端任务" /> : null}
        {tasks.map((task) => <Card key={task.id} title={task.model} extra={<Tag>{labels[task.status] || task.status}</Tag>}>
            <p className="mb-3 text-xs text-muted-foreground">{new Date(task.created_at).toLocaleString()}</p>
            {task.error ? <div className="space-y-2 text-sm"><p>{task.error_message || "任务暂时无法完成，请联系管理员。"}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">错误详情</summary><p className="mt-2 break-all">错误码：{task.error}<br />任务 ID：{task.id}</p></details></div> : null}
            {task.result?.text ? <p className="whitespace-pre-wrap">{task.result.text}</p> : null}
            {Array.isArray(task.result?.data) ? <Image.PreviewGroup>{task.result.data.map((image, index) => image.url ? <Image key={index} src={image.url} width={180} /> : null)}</Image.PreviewGroup> : null}
            {task.result?.url ? <a href={task.result.url} download>下载生成文件</a> : null}
            {task.capability === "video" && task.upstream_id ? <div className="mt-3 flex gap-3"><Button onClick={() => void refreshVideo(task)}>查询视频状态</Button>{task.status === "succeeded" ? <a href={`/api/ai/${task.channel_id}/v1/videos/${task.upstream_id}/content`} download>下载视频</a> : null}</div> : null}
        </Card>)}
    </div></main>;
}
