import type { StateStorage } from "zustand/middleware";
import { createUserStore } from "@/services/cloud-storage";

const store = createUserStore("app_state");
export const cloudStateStorage: StateStorage = {
    getItem: (name) => store.getItem<string>(name),
    setItem: async (name, value) => { await store.setItem(name, value); },
    removeItem: (name) => store.removeItem(name),
};
