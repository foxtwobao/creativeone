import { cloudApi } from "./cloud";

export const canvasTaskStatus = (id: string) => cloudApi<{ contentRevision: number; tasks: Array<{ id: string; status: string; generationId: string }> }>(`/projects/${id}/task-status`);

// A disconnected/aborted browser stops waiting; the accepted server task continues.
export async function canvasGenerationResult<T>(data: T, signal?: AbortSignal, waitForCompletion = false): Promise<T> {
    const id = (data as { canvasTaskId?: string })?.canvasTaskId;
    if (!id) return data;
    const pause = () => new Promise<void>((resolve, reject) => {
        const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); document.removeEventListener("visibilitychange", visible); };
        const done = () => { clear(); resolve(); };
        const abort = () => { clear(); reject(signal?.reason || new DOMException("已停止等待", "AbortError")); };
        const visible = () => { if (!document.hidden) done(); };
        const timer = setTimeout(() => { if (!document.hidden) done(); }, 5000);
        signal?.addEventListener("abort", abort, { once: true });
        document.addEventListener("visibilitychange", visible);
        if (signal?.aborted) abort();
    });
    while (true) {
        signal?.throwIfAborted();
        if (document.hidden) { await pause(); continue; }
        const task = await cloudApi<{ status: string; result: T; error_message?: string; upstream_id?: string }>(`/tasks/${id}`, { signal });
        if (task.status === "succeeded" || !waitForCompletion && task.status === "pending" && task.upstream_id) return task.result;
        if (!["pending", "running"].includes(task.status)) throw new Error(task.error_message || "任务结果尚未确认，请查看原任务；请勿重复提交。");
        await pause();
    }
}

export async function recoverCanvasImage(taskId: string) {
    const task = await cloudApi<{ status: string; result_available: boolean }>(`/tasks/${taskId}`);
    if (["pending", "running"].includes(task.status)) return "active";
    if (task.status === "succeeded") return "complete";
    if (task.status === "unknown" && !task.result_available) return "unknown";
    if (task.status !== "unknown" || !task.result_available) return false;
    await cloudApi(`/tasks/${taskId}/resume-result`, { method: "POST" });
    return true;
}
