import { create } from "zustand";
import { cloudSession } from "@/services/api/cloud";
import { fetchAnnouncements, markAnnouncementRead } from "@/services/api/announcements";
import { useCloudStore } from "./use-cloud-store";
import type { AnnouncementDetail, AnnouncementSummary } from "../../../shared/announcements";

let request: AbortController | null = null;
const acknowledged = new Set<string>();
export const useAnnouncementStore = create<{
    items: AnnouncementSummary[]; owner: string | null; loading: boolean; error: string;
    load: () => Promise<void>; reset: () => void;
    markRead: (item: AnnouncementDetail, signal: AbortSignal) => Promise<boolean>;
}>((set, get) => ({
    items: [], owner: null, loading: false, error: "",
    reset: () => { request?.abort(); request = null; acknowledged.clear(); set({ items: [], owner: null, loading: false, error: "" }); },
    load: async () => {
        const userId = cloudSession?.user.id;
        if (!userId || useCloudStore.getState().errors.session || (get().owner === userId && get().loading)) return;
        request?.abort();
        const controller = new AbortController(); request = controller;
        set({ items: [], owner: userId, loading: true, error: "" });
        const current = () => request === controller && cloudSession?.user.id === userId && get().owner === userId && !useCloudStore.getState().errors.session;
        try {
            const items = new Map<string, AnnouncementSummary>();
            let offset = 0;
            while (current()) {
                const page = await fetchAnnouncements(offset, controller.signal);
                if (!current()) return;
                for (const item of page.items) if (!items.has(item.id)) items.set(item.id, item);
                if (!page.hasMore) break;
                if (!page.items.length || page.nextOffset <= offset) throw new Error("公告暂不可用，请稍后手动刷新。");
                offset = page.nextOffset;
            }
            if (current()) set({ items: [...items.values()].map(item => ({ ...item, read: item.read || acknowledged.has(`${item.id}:${item.revision}`) })) });
        } catch (error) {
            if (current() && !controller.signal.aborted) set({ error: error instanceof Error ? error.message : "公告暂不可用" });
        } finally { if (request === controller) { request = null; set({ loading: false }); } }
    },
    markRead: async (item, signal) => {
        const userId = cloudSession?.user.id;
        if (!userId || get().owner !== userId || useCloudStore.getState().errors.session) return false;
        await markAnnouncementRead(item.id, item.revision, signal);
        if (!signal.aborted && cloudSession?.user.id === userId && get().owner === userId && !useCloudStore.getState().errors.session) {
            acknowledged.add(`${item.id}:${item.revision}`);
            set(state => ({ items: state.items.map(current => current.id === item.id && current.revision === item.revision ? { ...current, read: true } : current) }));
            return true;
        }
        return false;
    },
}));
