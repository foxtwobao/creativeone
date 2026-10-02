import { create } from "zustand";
import { getAccountResource, changeAccountResource } from "@/services/api/account";
import { DEFAULT_PROMPT_SOURCES, createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";
export type PromptSourceSchedule = { intervalMinutes: number; lastFetchedAt: string };
export const PROMPT_SOURCE_INTERVALS = [0, 30, 60, 360, 1440];
type SourceState = { sources: PromptSource[]; schedule: PromptSourceSchedule };
type PromptSourceStore = SourceState & {
    load: () => Promise<void>;
    addSource: () => PromptSource;
    saveSource: (source: PromptSource) => Promise<void>;
    removeSource: (id: string) => Promise<void>;
    toggleSource: (id: string, enabled: boolean) => Promise<void>;
    updateSchedule: (key: "intervalMinutes", value: number) => Promise<void>;
};
export const usePromptSourceStore = create<PromptSourceStore>()((set, get) => ({
    sources: DEFAULT_PROMPT_SOURCES, schedule: { intervalMinutes: 30, lastFetchedAt: "" },
    load: async () => set(await getAccountResource<SourceState>("/prompt-sources")),
    addSource: () => createPromptSource(),
    saveSource: async (source) => {
        const exists = get().sources.some((item) => item.id === source.id);
        set(await changeAccountResource<SourceState>(exists ? `/prompt-sources/${encodeURIComponent(source.id)}` : "/prompt-sources", source, exists ? "PATCH" : "POST"));
    },
    removeSource: async (id) => set(await changeAccountResource<SourceState>(`/prompt-sources/${encodeURIComponent(id)}`, undefined, "DELETE")),
    toggleSource: async (id, enabled) => set(await changeAccountResource<SourceState>(`/prompt-sources/${encodeURIComponent(id)}`, { enabled })),
    updateSchedule: async (_key, value) => set(await changeAccountResource<SourceState>("/prompt-schedule", { intervalMinutes: value })),
}));
