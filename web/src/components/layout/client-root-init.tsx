import { App, Button, Modal } from "antd";
import { useCloudStore } from "@/stores/use-cloud-store";
import { useEffect, useState, type ReactNode } from "react";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { cloudApi, cloudSession } from "@/services/api/cloud";
import { flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";
import { retryCloudSave } from "@/services/cloud-storage";

export function ClientRootInit({ children }: { children: ReactNode }) {
    usePromptSourceScheduler();
    const { message } = App.useApp();
    const modelLoginRequired = useCloudStore((state) => state.modelLoginRequired);
    const setModelLoginRequired = useCloudStore((state) => state.setModelLoginRequired);
    const [starting, setStarting] = useState(false);
    const [resumeMessage] = useState(() => useCloudStore.getState().authorizationResume?.message);
    useEffect(() => {
        const url = new URL(window.location.href);
        if (url.searchParams.has("modelAuthorization")) {
            url.searchParams.delete("modelAuthorization");
            window.history.replaceState(null, "", url.pathname + url.search + url.hash);
            message.error("授权流程已失效，请重新发起授权");
        } else if (resumeMessage) message.info(resumeMessage);
    }, [message, resumeMessage]);
    const authorize = async () => {
        setStarting(true);
        try {
            const draft = useCloudStore.getState().authorizationDraft?.() ?? null;
            await flushCanvasPersistence();
            await retryCloudSave();
            const state = useCloudStore.getState();
            if (state.saving || Object.keys(state.errors).length) throw new Error("还有未保存的修改，请先处理保存失败或冲突，再授权");
            const result = await cloudApi<{ authorizationUrl?: string; authorized?: boolean; pending?: boolean }>("/model-authorization", {
                method: "POST", body: JSON.stringify({ returnTo: window.location.pathname + window.location.search, draft }),
            });
            if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
            else if (result.pending) message.info("此登录会话已有授权流程，请在原页面完成；过期后可重新发起");
            else if (result.authorized) { state.setModelAuthorized(true); message.success("模型服务已授权，请手动继续生成"); }
            else throw new Error("暂时无法确认授权结果，请重新发起授权");
        } catch (error) { message.error(error instanceof Error ? error.message : "授权启动失败，请重试"); }
        finally { setStarting(false); }
    };
    return <>{children}
        <Modal title="授权使用 TokenONE 模型服务" open={modelLoginRequired} onCancel={() => setModelLoginRequired(false)} footer={null}>
            <div className="space-y-3 text-sm leading-6">
                <p>授权后，画布ONE将通过你的 TokenONE 账号调用模型服务。模型调用产生的费用将从你的 TokenONE 账户余额中扣除。</p>
                <p>各模型的价格及计费规则，请在 TokenONE 模型广场查看。</p>
                {cloudSession?.modelServiceUrl ? <div className="flex flex-wrap gap-x-5 gap-y-2">
                    <a href={`${cloudSession.modelServiceUrl}/pricing`} target="_blank" rel="noopener noreferrer">查看模型价格 ↗</a>
                    <a href={cloudSession.modelServiceUrl} target="_blank" rel="noopener noreferrer">前往 TokenONE ↗</a>
                </div> : null}
                <p className="text-xs text-muted-foreground">继续前会保存当前编辑内容，授权完成后返回此页。授权本身不会提交生成任务。</p>
            </div>
            <Button className="mt-4" type="primary" loading={starting} onClick={() => void authorize()}>同意并前往授权</Button>
        </Modal>
    </>;
}
