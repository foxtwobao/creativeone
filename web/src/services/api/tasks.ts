import { cloudApi } from "./cloud";

export type Task = { id: string; channel_id: string; upstream_id?: string; model: string; capability: string; status: string; result?: { text?: string; url?: string; content?: { video_url?: string }; data?: { url?: string }[] }; error?: string; error_message?: string; created_at: string };

export const fetchTasks = () => cloudApi<{ tasks: Task[] }>("/tasks");
export const queryVideoTask = (task: Task) => cloudApi<{ status?: string }>(`/ai/${task.channel_id}/v1/contents/generations/tasks/${encodeURIComponent(task.upstream_id!)}`);
