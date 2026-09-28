import { Modal } from "antd";
import { useCloudStore } from "@/stores/use-cloud-store";
import type { ReactNode } from "react";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

export function ClientRootInit({ children }: { children: ReactNode }) {
    usePromptSourceScheduler();
    const modelLoginRequired = useCloudStore((state) => state.modelLoginRequired);
    const setModelLoginRequired = useCloudStore((state) => state.setModelLoginRequired);
    return <>{children}
        <Modal title="关联模型服务账户" open={modelLoginRequired} onCancel={() => setModelLoginRequired(false)} footer={null}>
            <p>请先登录模型服务完成账户关联，完成后回到此页重试。</p>
            <a className="mt-3 inline-block text-primary underline" href="https://tokenonereseller.lab.home.arpa/auth/login" target="_blank" rel="noopener noreferrer" onClick={() => setModelLoginRequired(false)}>前往模型服务登录（新标签页）</a>
        </Modal>
    </>;
}
