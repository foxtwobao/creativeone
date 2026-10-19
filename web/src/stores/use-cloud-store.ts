import { create } from "zustand";
import { cloudSession } from "@/services/api/cloud";
import { fetchAccountBalance } from "@/services/api/account-pricing";
import type { AccountBalance } from "../../../shared/account-pricing";
import { useAnnouncementStore } from "./use-announcement-store";
import type { AuthorizationResume } from "@/services/api/model-authorization";

let balanceRequest: AbortController | null = null;

export const useCloudStore = create<{
    balance: AccountBalance | null;
    balanceOwner: string | null;
    balanceLoading: boolean;
    balanceError: string;
    loadBalance: () => Promise<void>;
    clearBalance: () => void;
    authorizationResume: AuthorizationResume | null;
    setAuthorizationResume: (resume: AuthorizationResume | null) => void;
    authorizationRecovering: boolean;
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
}>((set, get) => ({
    balance: null, balanceOwner: null, balanceLoading: false, balanceError: "",
    clearBalance: () => {
        balanceRequest?.abort(); balanceRequest = null;
        set({ balance: null, balanceOwner: null, balanceLoading: false, balanceError: "" });
    },
    loadBalance: async () => {
        const userId = cloudSession?.user.id;
        if (!userId || get().errors.session || (get().balanceLoading && get().balanceOwner === userId)) return;
        balanceRequest?.abort();
        const request = new AbortController(); balanceRequest = request;
        set({ balanceOwner: userId, balance: null, balanceLoading: true, balanceError: "" });
        const current = () => balanceRequest === request && cloudSession?.user.id === userId && get().balanceOwner === userId && !get().errors.session;
        try {
            const balance = await fetchAccountBalance(request.signal);
            if (current()) set({ balance });
        } catch (error) {
            if (current() && !request.signal.aborted) set({ balanceError: error instanceof Error ? error.message : "余额暂不可用" });
        } finally {
            if (balanceRequest === request) { balanceRequest = null; set({ balanceLoading: false }); }
        }
    },
    authorizationResume: null,
    authorizationRecovering: false,
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
    setError: (key, error, code) => {
        if (key === "session" && error) useAnnouncementStore.getState().reset();
        set((state) => {
            const errors = { ...state.errors }, errorCodes = { ...state.errorCodes };
            if (error) errors[key] = error; else delete errorCodes[key];
            if (error && code) errorCodes[key] = code; else delete errorCodes[key];
            return { errors, errorCodes, ...(errors.session ? { balance: null, balanceOwner: null, balanceLoading: false, balanceError: "" } : {}) };
        });
    },
}));
