import { useEffect } from "react";
import { useCloudStore } from "@/stores/use-cloud-store";
import { cloudApi } from "@/services/api/cloud";

// Page memory is saved on the server only when leaving for authorization.
export function useAuthorizationDraft<T>(draft: T, restore: (draft: T) => void, running: boolean) {
    useEffect(() => {
        const state = useCloudStore.getState();
        const resume = state.authorizationResume;
        if (resume && resume.returnTo === window.location.pathname + window.location.search && resume.draft) {
            restore(resume.draft as T);
            state.setAuthorizationResume(null);
            void cloudApi("/model-authorization/resume", { method: "DELETE" }).catch(() => undefined);
        }
    }, []);
    useEffect(() => {
        useCloudStore.getState().setAuthorizationDraft(() => {
            if (running) throw new Error("生成仍在进行，请等待完成并确认任务状态后再授权");
            return draft;
        });
        return () => useCloudStore.getState().setAuthorizationDraft(null);
    }, [draft, running]);
}
