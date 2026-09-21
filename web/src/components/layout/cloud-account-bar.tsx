import { App, Button, Modal } from "antd";
import { Link } from "react-router-dom";
import { useState } from "react";
import { saveAs } from "file-saver";
import { cloudSession, logoutCloud } from "@/services/api/cloud";
import { discardCloudDrafts, exportCloudDrafts, retryCloudSync } from "@/services/cloud-storage";
import { useCloudStore } from "@/stores/use-cloud-store";
import { flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";

export function CloudAccountBar() {
    const { message, modal } = App.useApp();
    const saving = useCloudStore((state) => state.saving);
    const errors = useCloudStore((state) => state.errors);
    const [details, setDetails] = useState(false);
    const sync = async () => {
        try {
            await flushCanvasPersistence();
            await retryCloudSync();
            if (!Object.keys(useCloudStore.getState().errors).length) window.location.reload();
            else setDetails(true);
        } catch (error) { message.error(error instanceof Error ? error.message : "同步失败"); }
    };
    const logout = async () => {
        try { await flushCanvasPersistence(); await logoutCloud(); }
        catch (error) { message.error(error instanceof Error ? error.message : "退出失败"); }
    };
    return <>
        <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2 bg-background px-4 text-xs text-muted-foreground">
            <span>{cloudSession?.user.displayName}</span>
            <div className="flex items-center gap-3">
                <button onClick={() => setDetails(true)}>{Object.keys(errors).length ? "同步需要处理" : saving ? "正在保存…" : "已连接云端"}</button>
                <button disabled={saving > 0} onClick={() => void sync()}>同步</button>
                <Link to="/tasks">云端任务</Link>
                {cloudSession?.user.admin ? <Link to="/admin/channels">渠道管理</Link> : null}
                <button disabled={saving > 0} onClick={() => void logout()}>退出</button>
            </div>
        </div>
        <Modal title="云端同步" open={details} onCancel={() => setDetails(false)} footer={null}>
            <div className="space-y-3">
                {Object.values(errors).length ? Object.entries(errors).map(([key, error]) => <p key={key} className="text-sm text-red-500">{error}</p>) : <p>修改会自动保存；在其他设备修改后，点击「同步」加载最新内容。</p>}
                <div className="flex flex-wrap gap-2">
                    <Button disabled={saving > 0} onClick={() => void sync()}>重试同步</Button>
                    <Button onClick={() => void exportCloudDrafts().then((blob) => saveAs(blob, "creativeone-drafts.json"))}>导出未同步草稿</Button>
                    <Button danger disabled={saving > 0} onClick={() => modal.confirm({ title: "丢弃本机未同步草稿？", content: "建议先导出草稿。继续将清除当前账号本机的未同步修改，并重新加载云端版本。", okText: "加载云端版本", cancelText: "取消", onOk: async () => { await flushCanvasPersistence(); await discardCloudDrafts(); } })}>加载云端版本</Button>
                </div>
            </div>
        </Modal>
    </>;
}
