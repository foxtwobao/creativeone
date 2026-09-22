import { cloudApi, cloudFileUrl, cloudSession, CloudError } from "@/services/api/cloud";
import { useCloudStore } from "@/stores/use-cloud-store";

type Entry = { key: string; value: unknown; revision: number; deleted: boolean; pending?: boolean };
type Store = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
    iterate<T, U>(callback: (value: T, key: string, iteration: number) => U): Promise<U>;
};
const stores = new Map<string, Store>();
const retries = new Set<() => Promise<void>>();
const documents = new Map<string, Map<string, Entry>>();
const jsonNamespaces = ["app_state", "preferences", "image_generation_logs", "video_generation_logs"];

// Disposable previews and fetched prompt caches live only for the current page.
export function createMemoryStore(): Store {
    const values = new Map<string, unknown>();
    return {
        async getItem<T>(key: string) { return (values.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) { values.set(key, value); return value; },
        async removeItem(key) { values.delete(key); },
        async keys() { return [...values.keys()]; },
        async clear() { values.clear(); },
        async iterate<T, U>(callback: (value: T, key: string, iteration: number) => U) {
            let index = 0;
            for (const [key, value] of values) {
                const result = callback(value as T, key, ++index);
                if (result !== undefined) return result;
            }
            return undefined as U;
        },
    };
}

export function createUserStore(namespace: string): Store {
    if (!cloudSession) throw new Error("登录后才能访问云端数据");
    const existing = stores.get(namespace);
    if (existing) return existing;
    if (!jsonNamespaces.includes(namespace)) {
        const media: Store = {
            async getItem<T>(key: string) {
                const response = await fetch(cloudFileUrl(namespace, key), { credentials: "same-origin", headers: { "X-Expected-User": cloudSession!.user.id } });
                if (response.status === 404) return null;
                if (!response.ok) throw new CloudError(response.status, "FILE_DOWNLOAD_FAILED");
                return await response.blob() as T;
            },
            async setItem<T>(key: string, value: T) {
                if (!(value instanceof Blob)) throw new Error("媒体必须是文件内容");
                const state = useCloudStore.getState(); state.begin();
                try { await cloudApi(`/files/${namespace}/${encodeURIComponent(key)}`, { method: "PUT", headers: { "Content-Type": value.type || "application/octet-stream" }, body: value }); }
                finally { state.end(); }
                return value;
            },
            async removeItem(key: string) { await cloudApi(`/files/${namespace}/${encodeURIComponent(key)}`, { method: "DELETE" }); },
            async keys() { return (await cloudApi<{ keys: string[] }>(`/files/${namespace}`)).keys; },
            async iterate<T, U>(callback: (value: T, key: string, iteration: number) => U) {
                let index = 0;
                for (const key of await media.keys()) {
                    const value = await media.getItem<T>(key);
                    if (value === null) continue;
                    const result = callback(value, key, ++index);
                    if (result !== undefined) return result;
                }
                return undefined as U;
            },
            async clear() { for (const key of await media.keys()) await media.removeItem(key); },
        };
        stores.set(namespace, media);
        return media;
    }
    const entries = new Map<string, Entry>();
    documents.set(namespace, entries);
    let loaded: Promise<void> | undefined;
    const queue = new Map<string, Promise<void>>();
    const load = () => loaded ??= (async () => {
        const remote = await cloudApi<{ entries: Entry[] }>(`/storage/${namespace}`);
        for (const entry of remote.entries) entries.set(entry.key, entry);
        useCloudStore.getState().setError(namespace);
    })().catch((error) => { loaded = undefined; useCloudStore.getState().setError(namespace, error.message); throw error; });
    const write = async (key: string, value: unknown, deleted: boolean) => {
        const state = useCloudStore.getState(), name = `${namespace}/${key}`;
        state.begin();
        const work = (queue.get(key) || Promise.resolve()).then(async () => {
            await load();
            const entry: Entry = { key, value, deleted, revision: entries.get(key)?.revision || 0, pending: true };
            entries.set(key, entry);
            try {
                const result = await cloudApi<{ revision: number }>(`/storage/${namespace}/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value, revision: entry.revision, deleted }) });
                entry.revision = result.revision; entry.pending = false;
                state.setError(name);
            } catch (error) {
                state.setError(name, error instanceof Error ? error.message : "保存失败，修改仅保留在当前页面", error instanceof CloudError ? error.code : undefined);
            }
        }).finally(() => state.end());
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
        for (const entry of [...entries.values()]) if (entry.pending) await write(entry.key, entry.value, entry.deleted);
    });
    stores.set(namespace, store);
    return store;
}

export async function retryCloudSave() { for (const retry of retries) await retry(); }
export async function initializeCloudStorage() {
    await Promise.all(jsonNamespaces.map((namespace) => createUserStore(namespace).keys()));
}
export function exportUnsavedChanges() {
    const data = Object.fromEntries([...documents].map(([namespace, entries]) => [namespace, [...entries.values()].filter((entry) => entry.pending)]));
    return new Blob([JSON.stringify({ userId: cloudSession?.user.id, documents: data }, null, 2)], { type: "application/json" });
}
