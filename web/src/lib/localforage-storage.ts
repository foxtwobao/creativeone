import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { createUserStore } from "@/services/cloud-storage";
import { CLOUD_ENABLED } from "@/services/api/cloud";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});
const cloudStore = CLOUD_ENABLED ? createUserStore("app_state") : null;

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (cloudStore) return cloudStore.getItem<string>(name);
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (cloudStore) { await cloudStore.setItem(name, value); return; }
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (cloudStore) { await cloudStore.removeItem(name); return; }
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
