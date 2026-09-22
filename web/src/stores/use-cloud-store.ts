import { create } from "zustand";

export const useCloudStore = create<{
    saving: number;
    errors: Record<string, string>;
    errorCodes: Record<string, string>;
    begin: () => void;
    end: () => void;
    setError: (key: string, error?: string, code?: string) => void;
}>((set) => ({
    saving: 0, errors: {}, errorCodes: {},
    begin: () => set((state) => ({ saving: state.saving + 1 })),
    end: () => set((state) => ({ saving: Math.max(0, state.saving - 1) })),
    setError: (key, error, code) => set((state) => {
        const errors = { ...state.errors }, errorCodes = { ...state.errorCodes };
        if (error) errors[key] = error; else delete errors[key];
        if (error && code) errorCodes[key] = code; else delete errorCodes[key];
        return { errors, errorCodes };
    }),
}));
