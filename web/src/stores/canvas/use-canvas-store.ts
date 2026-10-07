import { useCloudStore } from "@/stores/use-cloud-store";
import { create } from "zustand";
import { getAccountResource, changeAccountResource } from "@/services/api/account";
import { CloudError } from "@/services/api/cloud";
import i18n from "@/i18n";
import { nanoid } from "nanoid";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { canvasEditableNode, isCanvasMediaReplacement, preserveCanvasGeneration } from "../../../../shared/canvas-generations";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    contentRevision: number;
    generationRevision: number;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

export type CanvasProjectSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "contentRevision" | "generationRevision"> & { nodeCount: number; connectionCount: number };
const summary = (project: CanvasProject): CanvasProjectSummary => ({ id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, nodeCount: project.nodes.length, connectionCount: project.connections.length, contentRevision: project.contentRevision, generationRevision: project.generationRevision });
type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProjectSummary[];
    current: CanvasProject | null;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    pendingCount: number;
    externalSnapshot: number;
    history: { past: string[]; future: string[] };
    acceptProject: (project: CanvasProject) => void;
    restoreEdit: (direction: "undo" | "redo") => Promise<CanvasProject | null>;
    deletedProjects: CanvasDeletedProject[];
    load: () => Promise<void>;
    refreshProject: (id: string) => Promise<CanvasProject>;
    createProject: (title?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>) => Promise<string>;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => Promise<void>;
    deleteProjects: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

type ProjectPatch = Parameters<CanvasStore["updateProject"]>[1];
function applyCanvasPatch(project: CanvasProject, patch: ProjectPatch = {}): CanvasProject {
    const next = { ...project, ...patch };
    if (!patch.nodes) return next;
    const savedNodes = new Map(project.nodes.map((node) => [node.id, node]));
    return { ...next, nodes: patch.nodes.map((node) => isCanvasMediaReplacement(node, savedNodes.get(node.id)) ? node : preserveCanvasGeneration(node, savedNodes.get(node.id))) };
}
type CanvasGraphEdit =
    | { type: "put_node"; node: CanvasNodeData; replaceResult?: boolean }
    | { type: "delete_node"; id: string }
    | { type: "put_connection"; connection: CanvasConnection }
    | { type: "delete_connection"; id: string };
type PendingMutation = { patch: ProjectPatch; operationId: string; beforeNodes?: CanvasNodeData[]; beforeConnections?: CanvasConnection[] };
const pending = new Map<string, PendingMutation>();
type SubmittedCommand = { operationId: string; baseRevision: number; baseGenerationRevision: number; command: { type: "edit_project"; patch: ProjectPatch; graphEdits: CanvasGraphEdit[] } | { type: "restore_edit"; sourceOperationId: string; direction: "undo" | "redo" } };
const failedCommands = new Map<string, SubmittedCommand>();
let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let inFlight = 0;
let restoring = false;
let projectRequest = 0;
// Serialize server operations; this queue contains requests, not persisted business state.
function enqueueCanvasOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = saving.catch(() => undefined).then(operation);
    saving = result.then(() => undefined, () => undefined);
    return result;
}
function acceptRestoredProject(project: CanvasProject) {
    const mutation = pending.get(project.id);
    if (mutation) {
        const current = useCanvasStore.getState().openProject(project.id)!;
        const nodes = new Map(project.nodes.map((node) => [node.id, node]));
        const connections = new Map(project.connections.map((edge) => [edge.id, edge]));
        for (const edit of buildGraphEdits(mutation.beforeNodes || [], mutation.beforeConnections || [], current.nodes, current.connections)) {
            if (edit.type === "put_node") nodes.set(edit.node.id, edit.replaceResult ? edit.node : preserveCanvasGeneration(edit.node, nodes.get(edit.node.id)));
            if (edit.type === "delete_node") nodes.delete(edit.id);
            if (edit.type === "put_connection") connections.set(edit.connection.id, edit.connection);
            if (edit.type === "delete_connection") connections.delete(edit.id);
        }
        mutation.beforeNodes = project.nodes;
        mutation.beforeConnections = project.connections;
        mutation.patch = { ...mutation.patch, nodes: [...nodes.values()], connections: [...connections.values()].filter((edge) => nodes.has(edge.fromNodeId) && nodes.has(edge.toNodeId)) };
    }
    const next = applyCanvasPatch(project, mutation?.patch);
    useCanvasStore.getState().acceptProject(next);
    useCanvasStore.setState((state) => ({ externalSnapshot: state.externalSnapshot + 1 }));
    return next;
}
function confirmHistory(submitted: SubmittedCommand) {
    useCanvasStore.setState((state) => {
        const command = submitted.command;
        if (command.type === "edit_project") return command.graphEdits.length ? { history: { past: [...state.history.past.slice(-49), submitted.operationId], future: [] } } : {};
        const { past, future } = state.history;
        return { history: command.direction === "undo" ? { past: past.filter((id) => id !== command.sourceOperationId), future: [...future, command.sourceOperationId] } : { past: [...past, command.sourceOperationId], future: future.filter((id) => id !== command.sourceOperationId) } };
    });
}
function buildGraphEdits(beforeNodes: CanvasNodeData[], beforeConnections: CanvasConnection[], nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasGraphEdit[] {
    const edits: CanvasGraphEdit[] = [];
    const oldNodes = new Map(beforeNodes.map((node) => [node.id, node]));
    const oldConnections = new Map(beforeConnections.map((connection) => [connection.id, connection]));
    const nextNodeIds = new Set(nodes.map((node) => node.id));
    const nextConnectionIds = new Set(connections.map((connection) => connection.id));
    for (const node of beforeNodes) if (!nextNodeIds.has(node.id)) edits.push({ type: "delete_node", id: node.id });
    for (const connection of beforeConnections) if (!nextConnectionIds.has(connection.id)) edits.push({ type: "delete_connection", id: connection.id });
    for (const node of nodes) {
        const replaceResult = isCanvasMediaReplacement(node, oldNodes.get(node.id));
        if (replaceResult || JSON.stringify(canvasEditableNode(oldNodes.get(node.id))) !== JSON.stringify(canvasEditableNode(node))) edits.push({ type: "put_node", node, ...(replaceResult ? { replaceResult } : {}) });
    }
    for (const connection of connections) if (JSON.stringify(oldConnections.get(connection.id)) !== JSON.stringify(connection)) edits.push({ type: "put_connection", connection });
    return edits;
}
export const hasPendingCanvasPersistence = () => timer !== null || pending.size > 0 || failedCommands.size > 0 || inFlight > 0;
export async function flushCanvasPersistence() {
    if (timer) clearTimeout(timer);
    timer = null;
    return enqueueCanvasOperation(async () => {
        const ids = new Set([...failedCommands.keys(), ...pending.keys()]);
        for (const id of ids) {
            while (failedCommands.has(id) || pending.has(id)) {
                const current = useCanvasStore.getState().openProject(id);
                if (!current) { pending.delete(id); failedCommands.delete(id); break; }
                let submitted = failedCommands.get(id);
                if (!submitted) {
                    const mutation = pending.get(id)!;
                    const patch = { ...mutation.patch };
                    delete patch.nodes;
                    delete patch.connections;
                    const graphEdits = mutation.beforeNodes && mutation.beforeConnections ? buildGraphEdits(mutation.beforeNodes, mutation.beforeConnections, current.nodes, current.connections) : [];
                    submitted = { operationId: mutation.operationId, baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "edit_project", patch, graphEdits } };
                    pending.delete(id);
                    if (!graphEdits.length && !Object.keys(patch).length) { useCanvasStore.setState({ pendingCount: pending.size + failedCommands.size + inFlight }); continue; }
                }
                const cloud = useCloudStore.getState(); cloud.begin(); inFlight++;
                try {
                    const { project } = await changeAccountResource<{ project: CanvasProject }>(`/projects/${id}/commands`, submitted, "POST");
                    failedCommands.delete(id);
                    if (submitted.command.type === "restore_edit") acceptRestoredProject(project);
                    else useCanvasStore.getState().acceptProject(applyCanvasPatch(project, pending.get(id)?.patch));
                    confirmHistory(submitted);
                    cloud.setError(`projects/${id}`);
                } catch (error) {
                    failedCommands.set(id, submitted);
                    cloud.setError(`projects/${id}`, error instanceof Error ? error.message : "画布保存失败", error instanceof CloudError ? error.code : undefined);
                    throw error;
                } finally { inFlight--; cloud.end(); useCanvasStore.setState({ pendingCount: pending.size + failedCommands.size + inFlight }); }
            }
        }
    });
}
export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    hydrated: false, projects: [], deletedProjects: [], current: null, nodes: [], connections: [], pendingCount: 0, externalSnapshot: 0, history: { past: [], future: [] },
    acceptProject: (project) => set((state) => ({ current: project, nodes: project.nodes, connections: project.connections, projects: state.projects.some((item) => item.id === project.id) ? state.projects.map((item) => item.id === project.id ? summary(project) : item) : [summary(project), ...state.projects] })),
    restoreEdit: async (direction) => {
        if (restoring) return null;
        restoring = true;
        const retrying = get().current && failedCommands.get(get().current!.id)?.command.type === "restore_edit";
        const flushed = flushCanvasPersistence();
        try {
            return await enqueueCanvasOperation(async () => {
                await flushed;
                if (retrying) return get().current;
                const current = get().current, history = get().history;
                const sourceOperationId = (direction === "undo" ? history.past : history.future).at(-1);
                if (!current || !sourceOperationId) return null;
                const submitted: SubmittedCommand = { operationId: nanoid(), baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "restore_edit", sourceOperationId, direction } };
                const cloud = useCloudStore.getState(); cloud.begin(); inFlight++;
                try {
                    const { project } = await changeAccountResource<{ project: CanvasProject }>(`/projects/${current.id}/commands`, submitted, "POST");
                    const next = acceptRestoredProject(project);
                    confirmHistory(submitted);
                    cloud.setError(`projects/${current.id}`);
                    return next;
                } catch (error) {
                    failedCommands.set(current.id, submitted);
                    cloud.setError(`projects/${current.id}`, error instanceof Error ? error.message : "撤销失败", error instanceof CloudError ? error.code : undefined);
                    throw error;
                } finally { inFlight--; cloud.end(); set({ pendingCount: pending.size + failedCommands.size + inFlight }); }
            });
        } finally { restoring = false; }
    },
    load: async () => { await flushCanvasPersistence(); const state = await getAccountResource<{ projects: CanvasProjectSummary[]; deletedProjects: CanvasDeletedProject[] }>("/projects"); set({ ...state, hydrated: true }); },
    refreshProject: async (id) => {
        const request = ++projectRequest;
        const flushed = flushCanvasPersistence();
        return enqueueCanvasOperation(async () => {
            await flushed;
            const { project } = await getAccountResource<{ project: CanvasProject }>(`/projects/${id}`);
            if (request !== projectRequest) return project;
            const current = get().openProject(id);
            if (current && (project.contentRevision < current.contentRevision || project.generationRevision < current.generationRevision)) return current;
            const changed = current && current.contentRevision - current.generationRevision !== project.contentRevision - project.generationRevision;
            if (changed && pending.has(id)) {
                const error = new CloudError(409, "PROJECT_REVISION_CONFLICT");
                useCloudStore.getState().setError(`projects/${id}`, error.message, error.code);
                throw error;
            }
            const next = applyCanvasPatch(project, pending.get(id)?.patch);
            get().acceptProject(next);
            if (!current) set({ history: { past: [], future: [] } });
            if (changed) set((state) => ({ externalSnapshot: state.externalSnapshot + 1, history: { past: [], future: [] } }));
            return next;
        });
    },
    createProject: async (title = i18n.t("canvas.project.untitled")) => {
        ++projectRequest;
        const flushed = flushCanvasPersistence();
        return enqueueCanvasOperation(async () => {
            await flushed;
            const { project } = await changeAccountResource<{ project: CanvasProject }>("/projects", { title }, "POST");
            get().acceptProject(project); set({ history: { past: [], future: [] } }); return project.id;
        });
    },
    importProject: async (source) => {
        ++projectRequest;
        const flushed = flushCanvasPersistence();
        return enqueueCanvasOperation(async () => {
            await flushed;
            const { id: _id, createdAt: _created, updatedAt: _updated, contentRevision: _revision, generationRevision: _generationRevision, ...input } = source;
            const { project } = await changeAccountResource<{ project: CanvasProject }>("/projects", input, "POST");
            get().acceptProject(project); set({ history: { past: [], future: [] } }); return project.id;
        });
    },
    openProject: (id) => get().current?.id === id ? get().current : null,
    renameProject: async (id, title) => {
        const flushed = flushCanvasPersistence();
        return enqueueCanvasOperation(async () => {
            await flushed;
            const current = get().openProject(id) || get().projects.find((project) => project.id === id);
            if (!current) return;
            const { project } = await changeAccountResource<{ project: CanvasProject }>(`/projects/${id}/commands`, { operationId: nanoid(), baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "edit_project", patch: { title: title.trim() }, graphEdits: [] } }, "POST");
            get().acceptProject(applyCanvasPatch(project, pending.get(id)?.patch));
        });
    },
    deleteProjects: async (ids) => {
        ++projectRequest;
        const flushed = flushCanvasPersistence();
        return enqueueCanvasOperation(async () => {
            await flushed;
            for (const id of ids) { await changeAccountResource(`/projects/${id}`, undefined, "DELETE"); set((state) => ({ projects: state.projects.filter((item) => item.id !== id), ...(state.current?.id === id ? { current: null, nodes: [], connections: [], history: { past: [], future: [] } } : {}) })); }
        });
    },
    updateProject: (id, patch) => {
        const current = get().openProject(id);
        if (!current) return;
        const next = applyCanvasPatch(current, patch);
        patch = Object.fromEntries(Object.keys(patch).filter((key) => JSON.stringify(current[key as keyof CanvasProject]) !== JSON.stringify(next[key as keyof CanvasProject])).map((key) => [key, next[key as keyof CanvasProject]]));
        if (!Object.keys(patch).length) return;
        const previous = pending.get(id);
        get().acceptProject({ ...current, ...patch });
        pending.set(id, { patch: { ...previous?.patch, ...patch }, operationId: previous?.operationId || nanoid(), beforeNodes: previous?.beforeNodes || current?.nodes, beforeConnections: previous?.beforeConnections || current?.connections });
        set({ pendingCount: pending.size + failedCommands.size + inFlight });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void flushCanvasPersistence().catch(() => undefined); }, 400);
    },
}));

export const unsavedCanvasChanges = () => ({ projects: [...new Set([...pending.keys(), ...failedCommands.keys()])].map((id) => ({ project: useCanvasStore.getState().openProject(id), command: failedCommands.get(id), pending: pending.get(id) })) });
