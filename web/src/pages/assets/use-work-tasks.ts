import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { cloudSession } from "@/services/api/cloud";
import { fetchWorks, fetchTaskStatuses, type Task } from "@/services/api/tasks";
import { VIDEO_POLL_INTERVAL_MS } from "../../../../shared/video-tasks";

export function useWorkTasks(query: string) {
    const queryClient = useQueryClient();
    const userId = cloudSession?.user.id;
    const queryKey = useMemo(() => ["works", userId, query], [query, userId]);
    const result = useQuery({
        queryKey,
        // Leave the shared request running through StrictMode's effect replay.
        queryFn: () => fetchWorks(new URLSearchParams(query)),
        placeholderData: keepPreviousData,
        refetchOnMount: "always",
    });
    const [statusError, setStatusError] = useState("");
    const [, updateElapsed] = useReducer((value: number) => value + 1, 0);
    const { refetch } = result;
    const load = useCallback(async () => {
        await refetch({ cancelRefetch: false, throwOnError: true });
        setStatusError("");
    }, [refetch]);
    useEffect(() => {
        setStatusError("");
        const refresh = () => { if (!document.hidden) void load().catch(() => undefined); };
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [load, query]);
    const activeTasks = result.data?.activeTasks || [];
    const activeSignature = JSON.stringify(activeTasks.map(({ id, status }) => ({ id, status })));
    useEffect(() => {
        const active: Pick<Task, "id" | "status">[] = JSON.parse(activeSignature);
        if (!active.length) return;
        const abort = new AbortController();
        let polling = false;
        const timer = setInterval(async () => {
            if (document.hidden || polling || queryClient.isFetching({ queryKey, exact: true })) return;
            polling = true;
            try {
                const { tasks: statuses } = await fetchTaskStatuses(active.map((task) => task.id), abort.signal);
                if (abort.signal.aborted) return;
                if (statuses.length !== active.length || statuses.some((task) => active.find((item) => item.id === task.id)?.status !== task.status)) await load();
                else { setStatusError(""); updateElapsed(); }
            } catch (error) {
                if (!abort.signal.aborted) setStatusError(error instanceof Error ? error.message : "作品状态更新失败");
            } finally { polling = false; }
        }, VIDEO_POLL_INTERVAL_MS);
        return () => { clearInterval(timer); abort.abort(); };
    }, [activeSignature, load, queryClient, queryKey]);
    return { works: result.data?.works || [], total: result.data?.total || 0, activeTasks, error: result.error?.message || statusError, loading: result.isFetching, load };
}
