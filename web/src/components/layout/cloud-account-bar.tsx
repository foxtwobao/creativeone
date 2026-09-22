import { App, Button, Modal } from "antd";
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { cloudSession, logoutCloud } from "@/services/api/cloud";
import { exportUnsavedChanges, retryCloudSave } from "@/services/cloud-storage";
import { useCloudStore } from "@/stores/use-cloud-store";
import { flushCanvasPersistence, hasPendingCanvasPersistence } from "@/stores/canvas/use-canvas-store";

export function CloudAccountBar() {
    const { message, modal } = App.useApp();
    const saving = useCloudStore((state) => state.saving);
    const errors = useCloudStore((state) => state.errors);
    const conflict = useCloudStore((state) => Object.values(state.errorCodes).includes("SYNC_CONFLICT"));
    const [details, setDetails] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const failed = Object.keys(errors).length > 0;
    const needsLogin = Boolean(errors.session);
    const leaving = useRef(false);
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            const state = useCloudStore.getState();
            if (!leaving.current && (state.saving || Object.keys(state.errors).length || hasPendingCanvasPersistence())) {
                event.preventDefault(); event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, []);
    const retry = async () => {
        setRetrying(true);
        try {
            await flushCanvasPersistence();
            await retryCloudSave();
            setDetails(Object.keys(useCloudStore.getState().errors).length > 0);
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setRetrying(false); }
    };
    const logout = async () => {
        try {
            await flushCanvasPersistence();
            const state = useCloudStore.getState();
            if (state.saving || Object.keys(state.errors).length) {
                message.warning("还有未保存的修改，请先处理后再退出"); setDetails(true); return;
            }
            await logoutCloud();
        } catch (error) { message.error(error instanceof Error ? error.message : "退出失败"); }
    };
    return <>
        <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2 bg-background px-4 text-xs text-muted-foreground">
            <span>{cloudSession?.user.displayName}</span>
            <div className="flex items-center gap-3">
                {failed ? <>
                    <button onClick={() => setDetails(true)}>{conflict ? "版本冲突 · 处理" : "保存失败"}</button>
                    {!conflict && !needsLogin ? <button disabled={saving > 0 || retrying} onClick={() => void retry()}>{retrying ? "正在重试…" : "重试"}</button> : null}
                </> : <span role="status">{saving || retrying ? "正在保存…" : "已保存"}</span>}
                <Link to="/tasks">云端任务</Link>
                {cloudSession?.user.admin ? <Link to="/admin/channels">功能模型配置</Link> : null}
                <button disabled={saving > 0 || retrying} onClick={() => void logout()}>退出</button>
            </div>
        </div>
        <Modal title={needsLogin ? "登录状态已变化" : conflict ? "处理版本冲突" : "保存失败"} open={details && failed} onCancel={() => setDetails(false)} footer={null}>
            <div className="space-y-3">
                {Object.entries(errors).map(([key, error]) => <p key={key}>{error}</p>)}
                <p className="text-sm text-muted-foreground">未保存的修改仅保留在当前页面，关闭或刷新后会丢失。</p>
                <div className="flex flex-wrap gap-2">
                    {conflict || needsLogin ? <>
                        <Button disabled={saving > 0} onClick={async () => { await flushCanvasPersistence(); saveAs(exportUnsavedChanges(), "creativeone-unsaved.json"); }}>导出未保存修改</Button>
                        <Button danger disabled={saving > 0} onClick={() => modal.confirm({ title: "放弃当前页面未保存的修改？", content: "此操作将放弃所有未保存修改并重新读取云端数据。请先导出需要保留的内容。", okText: "放弃修改并加载云端", cancelText: "取消", onOk: () => { leaving.current = true; window.location.reload(); } })}>放弃修改并加载云端</Button>
                    </> : <Button loading={retrying} disabled={saving > 0} onClick={() => void retry()}>重试保存</Button>}
                </div>
            </div>
        </Modal>
    </>;
}
