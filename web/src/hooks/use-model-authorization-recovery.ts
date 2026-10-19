import { App } from "antd";
import { cloudSession } from "@/services/api/cloud";
import { recoverModelAuthorization } from "@/services/api/model-authorization";
import { useCloudStore } from "@/stores/use-cloud-store";

export function useModelAuthorizationRecovery() {
    const { message } = App.useApp();
    const recovering = useCloudStore(state => state.authorizationRecovering);
    const recover = async () => {
        if (useCloudStore.getState().authorizationRecovering) return;
        const user = cloudSession?.user.id;
        useCloudStore.setState({ authorizationRecovering: true });
        try {
            const result = await recoverModelAuthorization();
            if (cloudSession?.user.id !== user || useCloudStore.getState().errors.session) return;
            useCloudStore.getState().setAuthorizationResume(result);
            if (result?.result === "authorized") {
                useCloudStore.getState().setModelAuthorized(true);
                message.success("模型服务已授权，请返回原任务继续处理");
            } else if (result?.recoverable) message.info(result.message);
            else message.info(result?.message || "没有待确认的授权结果，请按需重新发起授权");
        } catch (error) {
            if (cloudSession?.user.id === user) message.error(error instanceof Error ? error.message : "暂时无法检查授权结果，请稍后重试");
        } finally { useCloudStore.setState({ authorizationRecovering: false }); }
    };
    return { recovering, recover };
}
