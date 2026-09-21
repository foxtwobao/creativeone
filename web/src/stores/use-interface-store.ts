import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useInterfaceStore = create<{ studio: boolean; setStudio: (studio: boolean) => void }>()(
    persist((set) => ({ studio: false, setStudio: (studio) => set({ studio }) }), { name: "infinite-canvas:interface" }),
);
