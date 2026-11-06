import { afterAll, beforeAll, expect, test } from "bun:test";
import { initializeCloud } from "../../services/api/cloud";
import type { CanvasProject } from "./use-canvas-store";
// Locale preferences require a browser API; canvas data never uses this storage.
const previousStorage = globalThis.localStorage;
if (!previousStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
const { flushCanvasPersistence, useCanvasStore } = await import("./use-canvas-store");
const { useCloudStore } = await import("../use-cloud-store");

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
    expect(useCloudStore.getState().errors[`projects/${saved.id}`]).toBeUndefined();
});

test("a viewport save synchronizes Agent nodes and preserves unrelated edits made during the request", async () => {
    let saved = project("agent-view");useCanvasStore.getState().acceptProject(saved);
    const started = deferred<void>(), response = deferred<Response>(), commands: any[] = [];
    handle = async (_path, init) => {
        const input = JSON.parse(String(init?.body));commands.push(input);
        if(commands.length===1){started.resolve();return response.promise;}
        expect(input.baseRevision).toBe(3);
        expect(input.command.graphEdits.map((edit:any)=>edit.node?.id)).toEqual(["b"]);
        saved={...saved,contentRevision:4,nodes:saved.nodes.map(node=>node.id==="b"?input.command.graphEdits[0].node:node)};
        return Response.json({project:saved});
    };
    const snapshot=useCanvasStore.getState().externalSnapshot;
    useCanvasStore.getState().updateProject(saved.id,{viewport:{x:10,y:20,k:2}});
    const saving=flushCanvasPersistence();await started.promise;
    useCanvasStore.getState().updateProject(saved.id,{nodes:saved.nodes.map(node=>node.id==="b"?{...node,title:"用户修改 B"}:node)});
    saved={...saved,contentRevision:3,viewport:{x:10,y:20,k:2},nodes:[{...saved.nodes[0],title:"助手修改 A"},saved.nodes[1],{...saved.nodes[0],id:"agent",title:"助手新增"}]};
    response.resolve(Response.json({project:saved}));await saving;
    expect(useCanvasStore.getState().externalSnapshot).toBe(snapshot+1);
    expect(useCanvasStore.getState().nodes.map(node=>node.title)).toEqual(["助手修改 A","用户修改 B","助手新增"]);
    expect(useCanvasStore.getState().pendingCount).toBe(0);
});

test("six generation results and zoom saves retain every result without content edits",async()=>{
    let saved={...project("six-results"),nodes:Array.from({length:6},(_,index)=>({id:`image-${index}`,type:"image" as any,title:`图片 ${index}`,position:{x:index*100,y:0},width:100,height:100,metadata:{generationId:`generation-${index}`,generationTaskId:`task-${index}`,status:"loading" as const}}))};
    useCanvasStore.getState().acceptProject(saved);
    const commands:any[]=[];
    handle=async(_path,init)=>{
        const input=JSON.parse(String(init?.body));commands.push(input);expect(input.command.graphEdits).toEqual([]);
        const index=[5,1,4,0,3,2][commands.length-1];
        saved={...saved,contentRevision:saved.contentRevision+1,generationRevision:saved.generationRevision+1,viewport:input.command.patch.viewport,nodes:saved.nodes.map((node,i)=>i===index?{...node,metadata:{...node.metadata,status:"success" as const,content:`/api/files/result-${index}`}}:node)};
        return Response.json({project:saved});
    };
    for(let index=0;index<6;index++){
        useCanvasStore.getState().updateProject(saved.id,{viewport:{x:index+1,y:0,k:1+index/10}});await flushCanvasPersistence();
    }
    expect(useCanvasStore.getState().nodes.every(node=>node.metadata?.status==="success")).toBe(true);
    expect(useCanvasStore.getState().nodes.map(node=>node.metadata?.generationTaskId)).toEqual(Array.from({length:6},(_,index)=>`task-${index}`));
    expect(commands).toHaveLength(6);
    expect(useCloudStore.getState().errors[`projects/${saved.id}`]).toBeUndefined();
});

test("external changes to the same pending node still stop saving and retain the local edit",async()=>{
    const saved=project("real-conflict");useCanvasStore.getState().acceptProject(saved);
    const started=deferred<void>(),response=deferred<Response>();let writes=0;
    handle=async()=>{writes++;started.resolve();return response.promise;};
    useCanvasStore.getState().updateProject(saved.id,{viewport:{x:10,y:20,k:2}});
    const saving=flushCanvasPersistence();await started.promise;
    useCanvasStore.getState().updateProject(saved.id,{nodes:saved.nodes.map(node=>node.id==="a"?{...node,title:"本地待保存"}:node)});
    response.resolve(Response.json({project:{...saved,contentRevision:3,nodes:saved.nodes.map(node=>node.id==="a"?{...node,title:"远端已修改"}:node)}}));
    await expect(saving).rejects.toThrow("画布已在其他页面更新");
    expect(writes).toBe(1);expect(useCanvasStore.getState().nodes[0].title).toBe("本地待保存");
    expect(useCloudStore.getState().errorCodes[`projects/${saved.id}`]).toBe("PROJECT_REVISION_CONFLICT");
    // An explicit resolution elsewhere may make both versions agree; clear this fixture's queue.
    handle=async()=>Response.json({project:{...saved,contentRevision:4,nodes:useCanvasStore.getState().nodes}});
    await flushCanvasPersistence();expect(useCanvasStore.getState().pendingCount).toBe(0);
});

test("Agent refresh rebases disjoint edits created while the snapshot is being read",async()=>{
    let saved=project("refresh-agent");useCanvasStore.getState().acceptProject(saved);
    const started=deferred<void>(),response=deferred<Response>();let writes=0;
    handle=async(_path,init)=>{
        if(!init?.body){started.resolve();return response.promise;}
        writes++;const input=JSON.parse(String(init.body));expect(input.baseRevision).toBe(3);
        expect(input.command.graphEdits.map((edit:any)=>edit.node?.id)).toEqual(["b"]);
        saved={...saved,contentRevision:4,nodes:saved.nodes.map(node=>node.id==="b"?input.command.graphEdits[0].node:node)};
        return Response.json({project:saved});
    };
    const refreshing=useCanvasStore.getState().refreshProject(saved.id);await started.promise;
    useCanvasStore.getState().updateProject(saved.id,{nodes:saved.nodes.map(node=>node.id==="b"?{...node,title:"本地 B"}:node)});
    saved={...saved,contentRevision:3,nodes:[{...saved.nodes[0],title:"云端 A"},saved.nodes[1],{...saved.nodes[0],id:"new-agent"}]};
    response.resolve(Response.json({project:saved}));await refreshing;await flushCanvasPersistence();
    expect(writes).toBe(1);expect(useCanvasStore.getState().nodes.map(node=>node.title)).toEqual(["云端 A","本地 B","a"]);
});

test("a lost viewport response can recover through refresh after Agent content changes",async()=>{
    const saved=project("lost-view");useCanvasStore.getState().acceptProject(saved);
    let submitted:any,writes=0;
    const remote={...saved,contentRevision:3,viewport:{x:9,y:8,k:2},nodes:[...saved.nodes,{...saved.nodes[0],id:"new-after-view"}]};
    handle=async(_path,init)=>{
        if(!init?.body)return Response.json({project:remote});
        writes++;const input=JSON.parse(String(init.body));
        if(!submitted){submitted=input;throw new Error("viewport response lost");}
        expect(input).toEqual(submitted);return Response.json({project:remote});
    };
    useCanvasStore.getState().updateProject(saved.id,{viewport:remote.viewport});
    await expect(flushCanvasPersistence()).rejects.toThrow("viewport response lost");
    await useCanvasStore.getState().refreshProject(saved.id);
    expect(writes).toBe(2);expect(useCanvasStore.getState().nodes).toHaveLength(3);
    expect(useCanvasStore.getState().pendingCount).toBe(0);expect(useCloudStore.getState().errors[`projects/${saved.id}`]).toBeUndefined();
});
