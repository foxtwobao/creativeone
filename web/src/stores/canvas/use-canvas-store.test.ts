import { afterAll, beforeAll, expect, test } from "bun:test";
import { initializeCloud } from "../../services/api/cloud";
import type { CanvasProject } from "./use-canvas-store";
// Locale preferences require a browser API; canvas data never uses this storage.
const previousStorage = globalThis.localStorage;
if (!previousStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
const { flushCanvasPersistence, useCanvasStore } = await import("./use-canvas-store");

const originalFetch = globalThis.fetch;
let handle: (path: string, init?: RequestInit) => Promise<Response>;
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const project = (id: string): CanvasProject => ({
    id, title: id, createdAt: "", updatedAt: "", contentRevision: 2, generationRevision: 0,
    nodes: ["a", "b"].map((id) => ({ id, type: "text", title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: id } })),
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});
beforeAll(async () => {
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/auth/me") return Response.json({ user: { id: "canvas-review" }, csrf: "test" });
        if (path === "/api/model-authorization") return Response.json(null);
        if (path === "/api/channels") return Response.json({ channels: [] });
        return handle(path, init);
    }) as typeof fetch;
    await initializeCloud();
});
afterAll(() => { globalThis.fetch = originalFetch; if (!previousStorage) Reflect.deleteProperty(globalThis, "localStorage"); });

test("edits made during undo are submitted after undo without restoring untouched nodes", async () => {
    let saved = project("undo");
    useCanvasStore.getState().acceptProject(saved);
    useCanvasStore.setState({ history: { past: ["original"], future: [] } });
    const started = deferred<void>(), response = deferred<Response>();
    const commands: any[] = [];
    handle = async (_path, init) => {
        const input = JSON.parse(String(init?.body));
        commands.push(input);
        if (input.command.type === "restore_edit") { started.resolve(); return response.promise; }
        expect(input.baseRevision).toBe(3);
        expect(input.command.graphEdits.map((edit: any) => edit.node?.id)).toEqual(["b"]);
        saved = { ...saved, contentRevision: 4, nodes: saved.nodes.map((node) => input.command.graphEdits.find((edit: any) => edit.node?.id === node.id)?.node || node) };
        return Response.json({ project: saved });
    };
    const undo = useCanvasStore.getState().restoreEdit("undo");
    await started.promise;
    useCanvasStore.getState().updateProject(saved.id, { nodes: saved.nodes.map((node) => node.id === "b" ? { ...node, title: "new edit" } : node) });
    const saving = flushCanvasPersistence();
    expect(commands).toHaveLength(1);
    saved = { ...saved, contentRevision: 3, nodes: saved.nodes.filter((node) => node.id !== "a") };
    response.resolve(Response.json({ project: saved }));
    const restored = await undo;
    expect(restored?.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(restored?.nodes[0].title).toBe("new edit");
    await saving;
    expect(useCanvasStore.getState().current?.nodes).toEqual(saved.nodes);
});

test("a refresh cannot replace a newer server revision or a subsequently requested project", async () => {
    const current = project("current");
    useCanvasStore.getState().acceptProject({ ...current, contentRevision: 5 });
    handle = async () => Response.json({ project: current });
    await useCanvasStore.getState().refreshProject(current.id);
    expect(useCanvasStore.getState().current?.contentRevision).toBe(5);
    const started = deferred<void>(), response = deferred<Response>();
    const next = project("next");
    handle = async (path) => {
        if (path.endsWith("/current")) { started.resolve(); return response.promise; }
        expect(useCanvasStore.getState().current?.contentRevision).toBe(5);
        return Response.json({ project: next });
    };
    const oldRead = useCanvasStore.getState().refreshProject(current.id);
    await started.promise;
    const nextRead = useCanvasStore.getState().refreshProject(next.id);
    response.resolve(Response.json({ project: { ...current, contentRevision: 6 } }));
    await Promise.all([oldRead, nextRead]);
    expect(useCanvasStore.getState().current?.id).toBe(next.id);
});

test("retrying a lost undo response notifies the canvas and confirms server history", async () => {
    const saved = project("retry-undo");
    useCanvasStore.getState().acceptProject(saved);
    useCanvasStore.setState({ history: { past: ["undo-lost"], future: [] } });
    let failed = false;
    handle = async (_path, init) => {
        const input = JSON.parse(String(init?.body));
        if (!failed) { failed = true; throw new Error("connection lost"); }
        expect(input.command.type).toBe("restore_edit");
        return Response.json({ project: { ...saved, contentRevision: 3, nodes: saved.nodes.filter((node) => node.id === "b") } });
    };
    await expect(useCanvasStore.getState().restoreEdit("undo")).rejects.toThrow("connection lost");
    const snapshot = useCanvasStore.getState().externalSnapshot;
    await flushCanvasPersistence();
    expect(useCanvasStore.getState().externalSnapshot).toBe(snapshot + 1);
    expect(useCanvasStore.getState().current?.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(useCanvasStore.getState().history.future).toEqual(["undo-lost"]);
});
