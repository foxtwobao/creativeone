import { cloudApi } from "./cloud";

type TaskResult = { text?: string; url?: string; file?: { url: string; storageKey?: string; width?: number; height?: number }; content?: { video_url?: string }; metadata?: { url?: string }; data?: TaskResult | { url?: string }[] };
export type Task = { id: string; channel_id: string; upstream_id?: string; model: string; capability: string; path: string; status: string; result?: TaskResult; request?: Record<string, any>; error?: string; error_message?: string; created_at: string };

export const fetchTasks = (signal?: AbortSignal) => cloudApi<{ tasks: Task[] }>("/tasks", { signal });
export const fetchTaskStatuses = (ids: string[], signal?: AbortSignal) => cloudApi<{ tasks: Pick<Task, "id" | "status">[] }>("/tasks/status", { method: "POST", body: JSON.stringify({ ids }), signal });
export const removeTaskFromWorks = (id: string) => cloudApi(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
export async function queryVideoTask(task: Task, resume = false) {
    const result = await cloudApi<{ status?: string; data?: { status?: string } }>(`/ai/${task.channel_id}/v1/${task.path === "videos" ? "videos" : "contents/generations/tasks"}/${encodeURIComponent(task.upstream_id!)}${resume ? "/resume" : ""}`, resume ? { method: "POST", body: "{}" } : undefined);
    return result.data || result;
}

export function taskVideoUrl(task: Task) {
    const result = task.result?.data && !Array.isArray(task.result.data) ? task.result.data : task.result;
    return task.path === "videos" ? result?.metadata?.url : result?.content?.video_url;
}

export const fetchWorks = (query: URLSearchParams, signal?: AbortSignal) => cloudApi<{ works: import("../../../../shared/works").Work[]; total: number; activeTasks: Pick<Task, "id" | "status">[] }>(`/works?${query}`, { signal });
