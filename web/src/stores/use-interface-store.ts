import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useInterfaceStore = create<{
    studio: boolean; setStudio: (studio: boolean) => void;
    canvasEntry: "assistant" | "library"; setCanvasEntry: (view: "assistant" | "library") => void;
}>()(
    persist((set) => ({ studio: false, setStudio: (studio) => set({ studio }), canvasEntry: "assistant", setCanvasEntry: (canvasEntry) => set({ canvasEntry }) }), { name: "infinite-canvas:interface" }),
);
