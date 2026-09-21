import localforage from "localforage";
import { CLOUD_ENABLED, cloudApi, cloudFileUrl, cloudSession, CloudError } from "@/services/api/cloud";
import { useCloudStore } from "@/stores/use-cloud-store";

type Entry = { key: string; value: unknown; revision: number; deleted: boolean; pending?: boolean };
type Store = Pick<LocalForage, "getItem" | "setItem" | "removeItem" | "iterate" | "clear" | "keys">;
const stores = new Map<string, Store>();
const retries = new Set<() => Promise<void>>();
const caches = new Map<string, LocalForage>();
const jsonNamespaces = new Set(["app_state", "preferences", "image_generation_logs", "video_generation_logs"]);

export function localUserStore(storeName: string) {
    return localforage.createInstance({ name: CLOUD_ENABLED ? `creativeone:${cloudSession?.user.id || "signed-out"}` : "infinite-canvas", storeName });
}

export function createUserStore(namespace: string): Store {
    if (!CLOUD_ENABLED) return localUserStore(namespace);
    if (!cloudSession) throw new Error("云端存储必须在登录完成后初始化");
    const existing = stores.get(namespace);
    if (existing) return existing;
    const cache = localUserStore(namespace);
    caches.set(namespace, cache);
    if (!jsonNamespaces.has(namespace)) {
        const media: Store = {
            async getItem<T>(key: string) {
                const cached = await cache.getItem<T>(key);
                if (cached) return cached;
                const response = await fetch(cloudFileUrl(namespace, key), { credentials: "same-origin", headers: { "X-Expected-User": cloudSession!.user.id } });
                if (response.status === 404) return null;
                if (!response.ok) throw new CloudError(response.status, "FILE_DOWNLOAD_FAILED");
                const blob = await response.blob();
                await cache.setItem(key, blob);
                return blob as T;
            },
            async setItem<T>(key: string, value: T) {
                if (!(value instanceof Blob)) throw new Error("媒体必须是文件内容");
                const state = useCloudStore.getState(); state.begin();
                try {
                    await cloudApi(`/files/${namespace}/${encodeURIComponent(key)}`, { method: "PUT", headers: { "Content-Type": value.type || "application/octet-stream" }, body: value });
                    await cache.setItem(key, value);
                } finally { state.end(); }
                return value;
            },
            async removeItem(key: string) {
                await cloudApi(`/files/${namespace}/${encodeURIComponent(key)}`, { method: "DELETE" });
                await cache.removeItem(key);
            },
            iterate: cache.iterate.bind(cache), keys: cache.keys.bind(cache),
            async clear() { for (const key of await cache.keys()) await media.removeItem(key); },
        };
        stores.set(namespace, media);
        return media;
    }
    const entries = new Map<string, Entry>();
    let loaded: Promise<void> | undefined;
    const queue = new Map<string, Promise<void>>();
    const load = () => loaded ??= (async () => {
        const remote = await cloudApi<{ entries: Entry[] }>(`/storage/${namespace}`);
        const local: Entry[] = [];
        await cache.iterate<Entry, void>((entry) => { local.push(entry); });
        for (const entry of remote.entries) entries.set(entry.key, entry);
        for (const draft of local.filter((entry) => entry.pending)) {
            const conflict = (entries.get(draft.key)?.revision || 0) !== draft.revision;
            entries.set(draft.key, draft);
            useCloudStore.getState().setError(`${namespace}/${draft.key}`, conflict ? "云端版本已更新，本地草稿保留，请导出后选择云端版本" : "有尚未同步的本地草稿，请点击重试同步");
        }
        for (const entry of entries.values()) await cache.setItem(entry.key, entry);
    })().catch((error) => { loaded = undefined; useCloudStore.getState().setError(namespace, error.message); throw error; });
    const send = async (entry: Entry) => {
        const state = useCloudStore.getState(), name = `${namespace}/${entry.key}`;
        state.begin();
        try {
            const result = await cloudApi<{ revision: number }>(`/storage/${namespace}/${encodeURIComponent(entry.key)}`, { method: "PUT", body: JSON.stringify({ value: entry.value, revision: entry.revision, deleted: entry.deleted }) });
            entry.revision = result.revision; entry.pending = false;
            await cache.setItem(entry.key, entry);
            state.setError(name); state.setError(namespace);
        } catch (error) { state.setError(name, error instanceof Error ? error.message : "同步失败，本地草稿已保留"); }
        finally { state.end(); }
    };
    const write = async (key: string, value: unknown, deleted: boolean) => {
        const work = (queue.get(key) || Promise.resolve()).then(async () => {
            await load();
            const entry: Entry = { key, value, deleted, revision: entries.get(key)?.revision || 0, pending: true };
            entries.set(key, entry);
            await cache.setItem(key, entry);
            await send(entry);
        });
        queue.set(key, work.catch(() => undefined));
        await work;
    };
    const store: Store = {
        async getItem<T>(key: string) { await load(); const entry = entries.get(key); return entry && !entry.deleted ? entry.value as T : null; },
        async setItem<T>(key: string, value: T) { await write(key, value, false); return value; },
        async removeItem(key: string) { await write(key, null, true); },
        async keys() { await load(); return [...entries.values()].filter((entry) => !entry.deleted).map((entry) => entry.key); },
        async iterate<T, U>(callback: (value: T, key: string, iterationNumber: number) => U) {
            await load(); let index = 0;
            for (const entry of entries.values()) {
                if (entry.deleted) continue;
                const result = callback(entry.value as T, entry.key, ++index);
                if (result !== undefined) return result;
            }
            return undefined as U;
        },
        async clear() { for (const key of await store.keys()) await store.removeItem(key); },
    };
    retries.add(async () => {
        await Promise.all(queue.values()); await load();
        for (const entry of entries.values()) if (entry.pending) await send(entry);
    });
    stores.set(namespace, store);
    return store;
}

export async function retryCloudSync() { for (const retry of retries) await retry(); }
export async function initializeCloudStorage() {
    if (!CLOUD_ENABLED) return;
    await Promise.all([...jsonNamespaces].map((namespace) => createUserStore(namespace).keys()));
}
export async function exportCloudDrafts() {
    const data: Record<string, Entry[]> = {};
    for (const [namespace, cache] of caches) {
        if (!jsonNamespaces.has(namespace)) continue;
        data[namespace] = [];
        await cache.iterate<Entry, void>((entry) => { if (entry.pending) data[namespace].push(entry); });
    }
    return new Blob([JSON.stringify({ userId: cloudSession?.user.id, documents: data }, null, 2)], { type: "application/json" });
}
export async function discardCloudDrafts() {
    for (const [namespace, cache] of caches) if (jsonNamespaces.has(namespace)) await cache.clear();
    window.location.reload();
}
