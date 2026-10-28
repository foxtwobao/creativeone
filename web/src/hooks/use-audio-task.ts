import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cloudSession } from "@/services/api/cloud";
import { fetchTask, fetchTaskStatuses } from "@/services/api/tasks";
import { VIDEO_POLL_INTERVAL_MS } from "../../../shared/video-tasks";

export function useAudioTask(taskId?: string) {
    const query = useQuery({ queryKey: ["audio-task", cloudSession?.user.id, taskId], queryFn: () => fetchTask(taskId!), enabled: Boolean(taskId), refetchOnMount: "always" });
    const [statusError, setStatusError] = useState("");
    const { refetch } = query;
    const load = useCallback(async () => {
        await refetch({ cancelRefetch: false, throwOnError: true });
        setStatusError("");
    }, [refetch]);
    const status = query.data?.status;
    useEffect(() => {
        setStatusError("");
        if (!taskId || !status || !["pending", "running"].includes(status)) return;
        const abort = new AbortController();
        let polling = false;
        const timer = setInterval(async () => {
            if (document.hidden || polling) return;
            polling = true;
            try {
                const { tasks } = await fetchTaskStatuses([taskId], abort.signal);
                if (!abort.signal.aborted) {
                    if (tasks[0]?.status !== status) await load();
                    else setStatusError("");
                }
            } catch (error) {
                if (!abort.signal.aborted) setStatusError(error instanceof Error ? error.message : "音频任务状态更新失败");
            } finally { polling = false; }
        }, VIDEO_POLL_INTERVAL_MS);
        return () => { clearInterval(timer); abort.abort(); };
    }, [taskId, status, load]);
    return { task: query.data, loading: query.isFetching, error: query.error?.message || statusError, load };
}
