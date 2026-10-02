import { afterAll, beforeAll, expect, test } from "bun:test";
import { initializeCloud } from "./api/cloud";
import { createMemoryStore, createUserStore, exportUnsavedChanges, refreshUserStore, retryCloudSave } from "./cloud-storage";
import { useCloudStore } from "../stores/use-cloud-store";

const originalFetch = globalThis.fetch;
const records = new Map<string, { value: unknown; revision: number; deleted: boolean }>();
let offline = false;
beforeAll(async () => {
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/auth/me") return Response.json({ user: { id: "alice" }, csrf: "test" });
        if (path === "/api/model-authorization") return Response.json(null);
        if (path === "/api/channels") return Response.json({ channels: [] });
        expect(new Headers(init?.headers).get("X-Expected-User")).toBe("alice");
        if (offline) throw new Error("offline");
        if (path === "/api/files/image_files") return Response.json({ keys: ["image:one"] });
        if (path.startsWith("/api/files/")) return new Response(new Blob(["image"]));
        const [,,, namespace, encodedKey] = path.split("/");
        if (init?.method === "PUT") {
            const id = `${namespace}/${decodeURIComponent(encodedKey)}`;
            const body = JSON.parse(String(init.body));
            expect(body).not.toHaveProperty("revision");
            const revision = (records.get(id)?.revision || 0)+1;
            records.set(id, { ...body, revision });
            return Response.json({ revision });
        }
        return Response.json({ entries: [...records].filter(([id]) => id.startsWith(`${namespace}/`)).map(([id, entry]) => ({ ...entry, key: id.slice(namespace.length + 1) })) });
    }) as typeof fetch;
    await initializeCloud();
});
afterAll(() => { globalThis.fetch = originalFetch; });

test("loads cloud state and serializes confirmed plugin key writes without client versions", async () => {
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
    await expect(store.setItem("config", "unsaved")).rejects.toThrow("offline");
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

test("media is read from the server and preview caches are disposable", async () => {
    const store = createUserStore("image_files");
    expect(await store.keys()).toEqual(["image:one"]);
    expect(await (await store.getItem<Blob>("image:one"))!.text()).toBe("image");
    const cache = createMemoryStore();
    await cache.setItem("preview", "temporary");
    expect(await createMemoryStore().getItem("preview")).toBeNull();
});

test("refresh reads another browser's server value while preserving a failed edit in page memory", async () => {
    const store = createUserStore("app_state");
    await store.setItem("plugin:dirty", "saved");
    offline = true;
    await expect(store.setItem("plugin:dirty", "unsaved")).rejects.toThrow("offline");
    offline = false;
    records.set("app_state/plugin:remote", {value: "other browser", revision: 1, deleted: false});
    await refreshUserStore("app_state");
    expect(await store.getItem("plugin:remote")).toBe("other browser");
    expect(await store.getItem("plugin:dirty")).toBe("unsaved");
    await retryCloudSave();
    expect(records.get("app_state/plugin:dirty")?.value).toBe("unsaved");
    expect(useCloudStore.getState().saving).toBe(0);
});
