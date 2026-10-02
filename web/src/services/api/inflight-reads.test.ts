import { afterAll, beforeAll, expect, test } from "bun:test";
import { changeAccountResource, getAccountResource } from "./account";
import { initializeCloud } from "./cloud";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let respond: (path: string, init?: RequestInit) => Response | Promise<Response>;
let assets: typeof import("@/stores/use-asset-store").useAssetStore;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

beforeAll(async () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://creative.test" } } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
    globalThis.fetch = (async (input, init) => {
        const path = String(input).replace(/^\/api/, "");
        if (path === "/auth/me") return Response.json({ user: { id: "inflight-test" }, csrf: "test" });
        if (path === "/channels") return Response.json({ channels: [] });
        if (path === "/model-authorization") return Response.json(null);
        return respond(path, init);
    }) as typeof fetch;
    await initializeCloud();
    assets = (await import("@/stores/use-asset-store")).useAssetStore;
    await (await import("@/i18n")).appLocaleReady;
});
afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("simultaneous account reads share one HTTP request", async () => {
    const response = deferred<Response>();
    let count = 0;
    respond = () => { count++; return response.promise; };
    const first = getAccountResource("/settings");
    const second = getAccountResource("/settings");
    expect(first).toBe(second);
    response.resolve(Response.json({ videoSize: "16:9" }));
    expect(await Promise.all([first, second])).toEqual([{ videoSize: "16:9" }, { videoSize: "16:9" }]);
    expect(count).toBe(1);
});

test("a read queued after saving settings never shares the earlier response", async () => {
    const response = deferred<Response>();
    const order: string[] = [];
    let size = "1:1";
    respond = (_path, init) => {
        order.push(init?.method || "GET");
        if (order.length === 1) return response.promise;
        if (init?.method === "PATCH") size = "16:9";
        return Response.json({ size });
    };
    const old = getAccountResource("/settings");
    const save = changeAccountResource("/settings", { size: "16:9" });
    const fresh = getAccountResource("/settings");
    expect(fresh).not.toBe(old);
    expect(getAccountResource("/settings")).toBe(fresh);
    response.resolve(Response.json({ size: "1:1" }));
    expect(await Promise.all([old, save, fresh])).toEqual([{ size: "1:1" }, { size: "16:9" }, { size: "16:9" }]);
    expect(order).toEqual(["GET", "PATCH", "GET"]);
});

test("schedule changes separate reads of the same prompt-source resource", async () => {
    const response = deferred<Response>();
    const order: string[] = [];
    respond = (path) => {
        order.push(path);
        return order.length === 1 ? response.promise : Response.json({ intervalMinutes: 60 });
    };
    const old = getAccountResource("/prompt-sources");
    const save = changeAccountResource("/prompt-schedule", { intervalMinutes: 60 });
    const fresh = getAccountResource("/prompt-sources");
    response.resolve(Response.json({ intervalMinutes: 30 }));
    expect((await Promise.all([old, save, fresh]))[2]).toEqual({ intervalMinutes: 60 });
    expect(order).toEqual(["/prompt-sources", "/prompt-schedule", "/prompt-sources"]);
});

test("a failed shared account read can be retried", async () => {
    let count = 0;
    respond = () => ++count === 1 ? Response.json({ error: "TEST_FAILED", message: "模拟读取失败" }, { status: 503 }) : Response.json({ ok: true });
    await expect(getAccountResource("/settings")).rejects.toThrow("模拟读取失败");
    expect(await getAccountResource("/settings")).toEqual({ ok: true });
    expect(count).toBe(2);
});

test("asset reads merge while mutations still preserve read-write-read order", async () => {
    assets.setState({ assets: [], hydrated: false });
    const response = deferred<Response>();
    const item = { id: "saved", kind: "text" as const, title: "已保存", coverUrl: "", tags: [], createdAt: "now", updatedAt: "now", data: { content: "文本" } };
    const order: string[] = [];
    respond = (_path, init) => {
        order.push(init?.method || "GET");
        if (order.length === 1) return response.promise;
        return Response.json(init?.method === "POST" ? { asset: item } : { assets: [item] });
    };
    const old = assets.getState().load();
    expect(assets.getState().load()).toBe(old);
    const { id, createdAt, updatedAt, ...input } = item;
    const save = assets.getState().addAsset(input);
    const fresh = assets.getState().load();
    expect(fresh).not.toBe(old);
    expect(assets.getState().load()).toBe(fresh);
    response.resolve(Response.json({ assets: [] }));
    await Promise.all([old, save, fresh]);
    expect(order).toEqual(["GET", "POST", "GET"]);
    expect(assets.getState().assets).toEqual([item]);
});

test("failed asset loads release the shared request for retry", async () => {
    let count = 0;
    respond = () => ++count === 1 ? Response.json({ error: "TEST_FAILED", message: "模拟素材读取失败" }, { status: 503 }) : Response.json({ assets: [] });
    await expect(assets.getState().load()).rejects.toThrow("模拟素材读取失败");
    await assets.getState().load();
    expect(count).toBe(2);
    expect(assets.getState().hydrated).toBe(true);
});
