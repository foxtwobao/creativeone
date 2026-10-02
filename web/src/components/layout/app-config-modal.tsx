import { Modal } from "antd";
import { lazy, Suspense } from "react";
import { useConfigStore } from "@/stores/use-config-store";

const CloudConfigPanel = lazy(() => import("./cloud-config-panel").then((module) => ({ default: module.CloudConfigPanel })));

export function AppConfigModal() {
    const open = useConfigStore((state) => state.isConfigOpen);
    const setOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return <Modal title="创作偏好" open={open} width={980} centered onCancel={() => setOpen(false)} styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }} footer={null}>
        <Suspense fallback={<p className="text-sm text-muted-foreground">正在加载创作偏好…</p>}><CloudConfigPanel /></Suspense>
    </Modal>;
}
