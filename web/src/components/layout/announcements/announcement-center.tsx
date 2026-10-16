import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Button, Drawer } from "antd";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowUpRight, Bell, Check, LoaderCircle, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { cloudSession, CloudError } from "@/services/api/cloud";
import { fetchAnnouncement } from "@/services/api/announcements";
import { useAnnouncementStore } from "@/stores/use-announcement-store";
import { useCloudStore } from "@/stores/use-cloud-store";
import type { AnnouncementDetail } from "../../../../../shared/announcements";
import AnnouncementMarkdown from "./announcement-markdown";

const date = (value: string) => new Date(value).toLocaleString("zh-CN");
export default function AnnouncementCenter() {
    const { items, owner, loading, error, load, markRead } = useAnnouncementStore();
    const sessionError = useCloudStore(state => state.errors.session);
    const userId = cloudSession?.user.id;
    const reducedMotion = useReducedMotion();
    const [open, setOpen] = useState(false);
    const [selection, setSelection] = useState<{ id: string; attempt: number } | null>(null);
    const [detail, setDetail] = useState<AnnouncementDetail | null>(null);
    const [detailError, setDetailError] = useState("");
    const [readError, setReadError] = useState("");
    const [dismissed, setDismissed] = useState<string[]>([]);
    const visible = owner === userId && !sessionError;
    const unread = visible ? items.filter(item => !item.read) : [];
    const incoming = unread.find(item => !dismissed.includes(`${item.id}:${item.revision}`));
    const dismiss = () => setDismissed(current => [...new Set([...current, ...unread.map(item => `${item.id}:${item.revision}`)])]);

    useEffect(() => {
        setOpen(false); setSelection(null); setDetail(null); setDismissed([]);
        if (!sessionError) void load();
    }, [load, userId, sessionError]);
    useEffect(() => {
        setDetail(null); setDetailError(""); setReadError("");
        if (!open || !selection || sessionError) return;
        const request = new AbortController();
        void fetchAnnouncement(selection.id, request.signal).then(item => {
            if (!request.signal.aborted && cloudSession?.user.id === userId) setDetail(item);
        }).catch(reason => {
            if (request.signal.aborted) return;
            setDetailError(reason instanceof Error ? reason.message : "公告暂不可用");
            if (reason instanceof CloudError && reason.code === "ANNOUNCEMENT_NOT_FOUND") void load();
        });
        return () => request.abort();
    }, [open, selection, userId, sessionError, load]);
    useEffect(() => {
        if (!open || !detail || detail.read || sessionError) return;
        const request = new AbortController();
        void markRead(detail, request.signal).then(saved => {
            if (saved && !request.signal.aborted) setDetail(current => current?.revision === detail.revision ? { ...current, read: true } : current);
        }).catch(reason => { if (!request.signal.aborted) setReadError(reason instanceof Error ? reason.message : "已读状态保存失败，请重试。"); });
        return () => request.abort();
    }, [open, detail, sessionError, markRead]);

    if (sessionError) return null;
    const show = (id?: string) => {
        dismiss(); setSelection(id ? { id, attempt: 0 } : null); setOpen(true);
        void load();
    };
    const retryDetail = () => setSelection(current => current ? { ...current, attempt: current.attempt + 1 } : null);
    return <>
        <button type="button" onClick={() => show()} title={error || "查看公告"} aria-label={unread.length ? `公告，${unread.length} 条未读` : "公告"} className={`inline-flex items-center gap-1.5 rounded py-1 ${unread.length ? "!font-medium !text-red-600 hover:!text-red-700 dark:!text-red-400 dark:hover:!text-red-300" : "hover:text-foreground"}`}>
            <motion.span className="relative inline-flex" key={incoming?.revision || "idle"} animate={!reducedMotion && incoming ? { rotate: [0, -18, 14, -8, 0] } : { rotate: 0 }} transition={{ duration: 0.8 }}>
                <Bell size={13} />
                {unread.length ? <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-red-500">
                    <span className="absolute inset-0 animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:animate-none" />
                </span> : null}
            </motion.span>
            公告{unread.length ? <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] leading-4 text-white tabular-nums">{unread.length}</span> : error ? <span className="text-[10px]">!</span> : null}
        </button>
        {createPortal(<AnimatePresence mode="wait">{incoming && !open && visible ? <motion.aside key={`${incoming.id}:${incoming.revision}`} role="status" aria-label="新公告提醒"
            initial={reducedMotion ? false : { opacity: 0, y: 70, x: 24, rotate: 7, scale: 0.9 }} animate={{ opacity: 1, y: 0, x: 0, rotate: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.95 }} transition={{ type: "spring", stiffness: 180, damping: 20 }}
            className="fixed bottom-5 right-5 z-40 w-80 max-w-[calc(100vw-2.5rem)]">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 -rotate-3 rounded-2xl border border-border bg-muted" />
            <div className="relative overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-xl">
                <div aria-hidden="true" className="absolute right-0 top-0 size-7 rounded-bl-2xl border-b border-l border-border bg-muted" />
                <button type="button" aria-label="关闭新公告提醒" onClick={dismiss} className="absolute right-9 top-3 z-10 rounded p-1 text-muted-foreground hover:text-foreground"><X size={14} /></button>
                <button type="button" onClick={() => show(incoming.id)} className="block w-full p-5 text-left">
                    <span className="mb-3 flex items-center gap-2 text-[11px] tracking-widest text-muted-foreground"><Sparkles size={13} />新公告已送达</span>
                    <span className="flex items-start gap-3">
                        <motion.span aria-hidden="true" initial={reducedMotion ? false : { x: -12, y: 8, rotate: -25 }} animate={{ x: 0, y: 0, rotate: -8 }} transition={{ delay: reducedMotion ? 0 : 0.2, type: "spring" }} className="pt-1"><Send size={26} strokeWidth={1.3} /></motion.span>
                        <span className="min-w-0 flex-1"><span className="line-clamp-2 break-words text-sm font-semibold leading-6">{incoming.title}</span><span className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{unread.length} 条未读 · 打开来信</span><ArrowUpRight size={15} /></span></span>
                    </span>
                </button>
            </div>
        </motion.aside> : null}</AnimatePresence>, document.body)}
        <Drawer title="公告" open={open} onClose={() => setOpen(false)} size="min(560px, 100vw)" destroyOnHidden
            styles={{ body: { padding: 0 } }} extra={<Button type="text" aria-label="刷新公告" icon={<RefreshCw size={15} />} loading={selection ? !detail && !detailError : loading} onClick={() => selection ? retryDetail() : void load()} />}>
            {selection ? <div className="p-6">
                <button type="button" onClick={() => setSelection(null)} className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={13} />全部公告</button>
                {detailError ? <Alert type="warning" showIcon title={detailError} action={<Button type="text" onClick={retryDetail}>重试</Button>} /> : !detail ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在打开公告…</p> : <>
                    <h2 className="mb-2 break-words text-xl font-semibold leading-8">{detail.title}</h2>
                    <p className="mb-6 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>{date(detail.publishedAt)}</span>{detail.read ? <span className="inline-flex items-center gap-1"><Check size={12} />已读</span> : <span>{readError ? "未读" : "正在记录已读…"}</span>}</p>
                    <AnnouncementMarkdown body={detail.body} />
                    {readError ? <Alert className="mt-5" type="warning" showIcon title="已读状态尚未保存" description={readError} action={<Button type="text" onClick={retryDetail}>重试</Button>} /> : null}
                </>}
            </div> : <>
                <p className="!mb-0 border-b border-border px-6 py-4 text-xs text-muted-foreground">{loading ? "正在收取公告…" : error ? "读取失败，可手动刷新" : `${items.length} 条公告 · ${unread.length} 条未读`}</p>
                {error ? <div className="p-6"><Alert type="warning" showIcon title="公告暂不可用" description={error} action={<Button type="text" onClick={() => void load()}>重试</Button>} /></div> : loading ? <p role="status" className="p-6 text-sm text-muted-foreground">正在读取公告…</p> : !items.length ? <p className="p-6 text-sm text-muted-foreground">暂无公告。</p> : items.map(item => <button type="button" key={item.id} onClick={() => setSelection({ id: item.id, attempt: 0 })} className="flex w-full items-start gap-3 border-b border-border px-6 py-5 text-left hover:bg-muted/50">
                    <span aria-hidden="true" className={`mt-2 size-1.5 shrink-0 rounded-full ${item.read ? "bg-border" : "bg-foreground"}`} />
                    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium leading-6">{item.title}</span><span className="mt-1 flex items-center gap-3 text-xs text-muted-foreground"><span>{date(item.publishedAt)}</span><span>{item.read ? "已读" : "未读"}</span></span></span><ArrowUpRight size={14} className="mt-1 text-muted-foreground" />
                </button>)}
            </>}
        </Drawer>
    </>;
}
