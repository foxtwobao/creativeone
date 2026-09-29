import { create } from "zustand";

export const useCloudStore = create<{
    authorizationResume: { returnTo: string; draft: unknown; result: string; message: string } | null;
    setAuthorizationResume: (resume: { returnTo: string; draft: unknown; result: string; message: string } | null) => void;
    authorizationDraft: (() => unknown) | null;
    setAuthorizationDraft: (capture: (() => unknown) | null) => void;
    modelAuthorized: boolean;
    setModelAuthorized: (authorized: boolean) => void;
    modelLoginRequired: boolean;
    setModelLoginRequired: (required: boolean) => void;
    saving: number;
    errors: Record<string, string>;
    errorCodes: Record<string, string>;
    begin: () => void;
    end: () => void;
    setError: (key: string, error?: string, code?: string) => void;
}>((set) => ({
    authorizationResume: null,
    setAuthorizationResume: (authorizationResume) => set((state) => ({ authorizationResume, modelAuthorized: authorizationResume ? authorizationResume.result === "authorized" : state.modelAuthorized })),
    authorizationDraft: null,
    setAuthorizationDraft: (authorizationDraft) => set({ authorizationDraft }),
    modelAuthorized: false,
    setModelAuthorized: (modelAuthorized) => set((state) => ({ modelAuthorized, modelLoginRequired: modelAuthorized ? false : state.modelLoginRequired })),
    modelLoginRequired: false,
    setModelLoginRequired: (modelLoginRequired) => set((state) => ({ modelLoginRequired, modelAuthorized: modelLoginRequired ? false : state.modelAuthorized })),
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
