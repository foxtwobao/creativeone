import { create } from "zustand";
import { getAccountResource, changeAccountResource } from "@/services/api/account";
export type InstalledPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    url: string; // Installation source used for updates.
    source: string; // Cached plugin source for offline use and pinned versions.
    enabled: boolean;
    local?: boolean; // Local plugin discovered in web/public/plugins; disabled by default and refetched from its URL when enabled.
    official?: boolean; // Installed from the official registry and grouped accordingly in the manager.
    installedAt: string;
};


type PluginStore = {
    plugins: InstalledPlugin[];
    load: () => Promise<void>;
    upsert: (plugin: Omit<InstalledPlugin, "installedAt"> & { installedAt?: string }) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    remove: (id: string) => Promise<void>;
};
export const usePluginStore = create<PluginStore>()((set) => ({
    plugins: [],
    load: async () => set(await getAccountResource<{ plugins: InstalledPlugin[] }>("/plugins")),
    upsert: async (plugin) => set(await changeAccountResource<{ plugins: InstalledPlugin[] }>("/plugins", plugin, "POST")),
    setEnabled: async (id, enabled) => set(await changeAccountResource<{ plugins: InstalledPlugin[] }>(`/plugins/${encodeURIComponent(id)}`, { enabled })),
    remove: async (id) => set(await changeAccountResource<{ plugins: InstalledPlugin[] }>(`/plugins/${encodeURIComponent(id)}`, undefined, "DELETE")),
}));
