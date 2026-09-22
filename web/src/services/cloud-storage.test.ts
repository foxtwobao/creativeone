import { afterAll, beforeAll, expect, test } from "bun:test";
import { initializeCloud } from "./api/cloud";
import { createMemoryStore, createUserStore, exportUnsavedChanges, retryCloudSave } from "./cloud-storage";
import { useCloudStore } from "../stores/use-cloud-store";

const originalFetch = globalThis.fetch;
const records = new Map<string, { value: unknown; revision: number; deleted: boolean }>();
let offline = false;
beforeAll(async () => {
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/auth/me") return Response.json({ user: { id: "alice" }, csrf: "test" });
        if (path === "/api/channels") return Response.json({ channels: [] });
        expect(new Headers(init?.headers).get("X-Expected-User")).toBe("alice");
        if (offline) throw new Error("offline");
        if (path === "/api/files/image_files") return Response.json({ keys: ["image:one"] });
        if (path.startsWith("/api/files/")) return new Response(new Blob(["image"]));
        const [,,, namespace, encodedKey] = path.split("/");
        if (init?.method === "PUT") {
            const id = `${namespace}/${decodeURIComponent(encodedKey)}`;
            const body = JSON.parse(String(init.body));
            if (body.revision !== (records.get(id)?.revision || 0)) return Response.json({ error: "SYNC_CONFLICT" }, { status: 409 });
            records.set(id, { ...body, revision: body.revision + 1 });
            return Response.json({ revision: body.revision + 1 });
        }
        return Response.json({ entries: [...records].filter(([id]) => id.startsWith(`${namespace}/`)).map(([id, entry]) => ({ ...entry, key: id.slice(namespace.length + 1) })) });
    }) as typeof fetch;
    await initializeCloud();
});
afterAll(() => { globalThis.fetch = originalFetch; });

test("loads cloud state and serializes writes against the latest revision", async () => {
    records.set("app_state/canvas", { value: "cloud", revision: 3, deleted: false });
    const store = createUserStore("app_state");
    expect(await store.getItem("canvas")).toBe("cloud");
    await Promise.all([store.setItem("canvas", "first"), store.setItem("canvas", "second")]);
    expect(records.get("app_state/canvas")).toEqual({ value: "second", revision: 5, deleted: false });
    expect(useCloudStore.getState().saving).toBe(0);
});

test("failed changes stay in memory and retry saves them without reporting success early", async () => {
    const store = createUserStore("preferences");
    await store.setItem("config", "saved");
    offline = true;
    await store.setItem("config", "unsaved");
    expect(records.get("preferences/config")?.value).toBe("saved");
    expect(await store.getItem("config")).toBe("unsaved");
    expect(useCloudStore.getState().errors["preferences/config"]).toBe("offline");
    expect(await exportUnsavedChanges().text()).toContain("unsaved");
    offline = false;
    await retryCloudSave();
    expect(records.get("preferences/config")?.value).toBe("unsaved");
    expect(useCloudStore.getState().errors["preferences/config"]).toBeUndefined();
    expect(useCloudStore.getState().saving).toBe(0);
});

test("revision conflicts preserve remote data and expose recoverable pending changes", async () => {
    const store = createUserStore("image_generation_logs");
    await store.setItem("history", "initial");
    records.set("image_generation_logs/history", { value: "other device", revision: 2, deleted: false });
    await store.setItem("history", "current page");
    await retryCloudSave();
    expect(records.get("image_generation_logs/history")?.value).toBe("other device");
    expect(useCloudStore.getState().errorCodes["image_generation_logs/history"]).toBe("SYNC_CONFLICT");
    expect(await exportUnsavedChanges().text()).toContain("current page");
});

test("media is read from the server and preview caches are disposable", async () => {
    const store = createUserStore("image_files");
    expect(await store.keys()).toEqual(["image:one"]);
    expect(await (await store.getItem<Blob>("image:one"))!.text()).toBe("image");
    const cache = createMemoryStore();
    await cache.setItem("preview", "temporary");
    expect(await createMemoryStore().getItem("preview")).toBeNull();
});
