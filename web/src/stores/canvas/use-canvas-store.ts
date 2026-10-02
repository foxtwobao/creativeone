import { useCloudStore } from "@/stores/use-cloud-store";
import { create } from "zustand";
import { getAccountResource, changeAccountResource } from "@/services/api/account";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

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
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    load: () => Promise<void>;
    createProject: (title?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>) => Promise<string>;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => Promise<void>;
    deleteProjects: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

type ProjectPatch = Parameters<CanvasStore["updateProject"]>[1];
const pending = new Map<string, ProjectPatch>();
let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
export const hasPendingCanvasPersistence = () => timer !== null || pending.size > 0;
export async function flushCanvasPersistence() {
    if (timer) clearTimeout(timer);
    timer = null;
    saving = saving.catch(() => undefined).then(async () => {
        const batch = [...pending]; pending.clear();
        for (let index = 0; index < batch.length; index++) {
            const [id, patch] = batch[index];
            const cloud = useCloudStore.getState(); cloud.begin();
            try {
                const { project } = await changeAccountResource<{ project: CanvasProject }>(`/projects/${id}`, patch);
                useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, updatedAt: project.updatedAt } : item) }));
                cloud.setError(`projects/${id}`);
            } catch (error) {
                for (const [key, remaining] of batch.slice(index)) pending.set(key, { ...remaining, ...pending.get(key) });
                cloud.setError(`projects/${id}`, error instanceof Error ? error.message : "画布保存失败");
                throw error;
            } finally { cloud.end(); }
        }
    });
    return saving;
}
export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    hydrated: false, projects: [], deletedProjects: [],
    load: async () => { await flushCanvasPersistence(); const state = await getAccountResource<{ projects: CanvasProject[]; deletedProjects: CanvasDeletedProject[] }>("/projects"); set({ ...state, hydrated: true }); },
    createProject: async (title = i18n.t("canvas.project.untitled")) => {
        const { project } = await changeAccountResource<{ project: CanvasProject }>("/projects", { title }, "POST");
        set((state) => ({ projects: [project, ...state.projects] })); return project.id;
    },
    importProject: async (source) => {
        const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = source;
        const { project } = await changeAccountResource<{ project: CanvasProject }>("/projects", input, "POST");
        set((state) => ({ projects: [project, ...state.projects] })); return project.id;
    },
    openProject: (id) => get().projects.find((item) => item.id === id) || null,
    renameProject: async (id, title) => {
        const { project } = await changeAccountResource<{ project: CanvasProject }>(`/projects/${id}`, { title: title.trim() });
        set((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, title: project.title, updatedAt: project.updatedAt } : item) }));
    },
    deleteProjects: async (ids) => {
        await flushCanvasPersistence();
        for (const id of ids) { await changeAccountResource(`/projects/${id}`, undefined, "DELETE"); set((state) => ({ projects: state.projects.filter((item) => item.id !== id) })); }
    },
    updateProject: (id, patch) => {
        set((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, ...patch } : item) }));
        pending.set(id, { ...pending.get(id), ...patch });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void flushCanvasPersistence().catch(() => undefined); }, 400);
    },
}));
