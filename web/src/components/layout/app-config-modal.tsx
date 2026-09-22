import { Modal } from "antd";
import { CloudConfigPanel } from "@/components/layout/cloud-config-panel";
import { useConfigStore } from "@/stores/use-config-store";

export function AppConfigModal() {
    const open = useConfigStore((state) => state.isConfigOpen);
    const setOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return <Modal title="创作偏好" open={open} width={980} centered onCancel={() => setOpen(false)} styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }} footer={null}>
        <CloudConfigPanel />
    </Modal>;
}
