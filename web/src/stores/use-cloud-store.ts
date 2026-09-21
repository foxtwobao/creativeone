import { create } from "zustand";

export const useCloudStore = create<{
    saving: number;
    errors: Record<string, string>;
    begin: () => void;
    end: () => void;
    setError: (key: string, error?: string) => void;
}>((set) => ({
    saving: 0, errors: {},
    begin: () => set((state) => ({ saving: state.saving + 1 })),
    end: () => set((state) => ({ saving: Math.max(0, state.saving - 1) })),
    setError: (key, error) => set((state) => {
        const errors = { ...state.errors };
        if (error) errors[key] = error; else delete errors[key];
        return { errors };
    }),
}));
