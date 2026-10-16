import { App, Button, Modal } from "antd";
import { Link } from "react-router-dom";
import { Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { cloudSession, logoutCloud } from "@/services/api/cloud";
import { exportUnsavedChanges, retryCloudSave } from "@/services/cloud-storage";
import { useCloudStore } from "@/stores/use-cloud-store";
import { flushCanvasPersistence, hasPendingCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { lazyWithReload } from "@/lib/lazy-with-reload";

const AnnouncementCenter = lazyWithReload(() => import("./announcements/announcement-center"));

export function CloudAccountBar() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const saving = useCloudStore((state) => state.saving);
    const errors = useCloudStore((state) => state.errors);
    const balance = useCloudStore((state) => state.balance);
    const balanceOwner = useCloudStore((state) => state.balanceOwner);
    const balanceLoading = useCloudStore((state) => state.balanceLoading);
    const balanceError = useCloudStore((state) => state.balanceError);
    const loadBalance = useCloudStore((state) => state.loadBalance);
    const userId = cloudSession?.user.id;
    useEffect(() => { void loadBalance(); }, [loadBalance, userId]);
    const [details, setDetails] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const pendingCanvas = useCanvasStore((state) => state.pendingCount);
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
        <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 bg-background py-2 pl-14 pr-4 text-xs text-muted-foreground min-[701px]:min-h-9 min-[701px]:py-0 min-[701px]:pl-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>{cloudSession?.user.displayName}</span>
                {!needsLogin ? <div role="group" aria-label="账户余额与充值" className="flex items-center gap-1.5">
                    <span role="status" title={balanceError || "按本站充值额度 1:1 展示余额，可能晚于实际扣费"} className="tabular-nums">
                        {balanceLoading ? "余额加载中…" : balance && balanceOwner === userId ? `余额 ${balance.amount} ${balance.unit === "USD" ? "CNY" : balance.unit}` : balanceError ? "余额暂不可用" : "余额 —"}
                    </span>
                    <button type="button" onClick={() => void loadBalance()} disabled={balanceLoading} aria-label="刷新余额" title={balanceError || "刷新余额"} className="rounded p-1 hover:bg-muted disabled:opacity-40"><RefreshCw size={12} className={balanceLoading ? "animate-spin" : ""} /></button>
                    <a href="https://token.agentone.work/wallet" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 font-medium text-foreground hover:bg-black/5 dark:hover:bg-white/10">{t("topNav.recharge")}<ArrowUpRight size={12} /></a>
                </div> : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
                {failed ? <>
                    <button onClick={() => setDetails(true)}>保存失败</button>
                    {!needsLogin ? <button disabled={saving > 0 || retrying} onClick={() => void retry()}>{retrying ? "正在重试…" : "重试"}</button> : null}
                </> : <span role="status">{saving || retrying || pendingCanvas ? "正在保存…" : "已保存"}</span>}
                <Suspense fallback={null}><AnnouncementCenter /></Suspense>
                <a href="https://home.agentone.work/">首页</a>
                <Link to="/pricing">模型价格</Link>
                {cloudSession?.user.admin ? <Link to="/admin/channels">功能模型配置</Link> : null}
                {cloudSession?.user.admin ? <Link to="/admin/tasks">用户任务</Link> : null}
                <button disabled={saving > 0 || retrying} onClick={() => void logout()}>退出</button>
            </div>
        </div>
        <Modal title={needsLogin ? "登录状态已变化" : "保存失败"} open={details && failed} onCancel={() => setDetails(false)} footer={null}>
            <div className="space-y-3">
                {Object.entries(errors).map(([key, error]) => <p key={key}>{error}</p>)}
                <p className="text-sm text-muted-foreground">未保存的修改仅保留在当前页面，关闭或刷新后会丢失。</p>
                <div className="flex flex-wrap gap-2">
                    <Button disabled={saving > 0} onClick={() => saveAs(exportUnsavedChanges(), "creativeone-unsaved.json")}>导出未保存修改</Button>
                    {!needsLogin ? <Button loading={retrying} disabled={saving > 0} onClick={() => void retry()}>重试保存</Button> : null}
                    <Button danger disabled={saving > 0} onClick={() => modal.confirm({ title: "放弃当前页面未保存的修改？", content: "此操作将放弃未保存修改并重新读取云端内容。请先导出需要保留的内容。", okText: "放弃修改并加载云端", cancelText: "取消", onOk: () => { leaving.current = true; window.location.reload(); } })}>重新加载云端</Button>
                </div>
            </div>
        </Modal>
    </>;
}
