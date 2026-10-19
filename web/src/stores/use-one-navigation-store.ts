import { create } from "zustand";
import { cloudSession } from "@/services/api/cloud";
import type { OneNavigation, OneNavigationConfig, OneNavigationPolicy } from "../../../shared/one-navigation";

type NavigationModule = {
    browserNavigation: (options: Omit<OneNavigationConfig, "moduleUrl">) => OneNavigation | null;
    createNavigationPolicy: (homeUrl: string, rechargeUrl: string, productHosts: string[]) => OneNavigationPolicy;
};
let loaded: Promise<NavigationModule> | undefined;
let read: (() => OneNavigation | null) | undefined;

export const useOneNavigationStore = create<{
    navigation: OneNavigation | null;
    refresh: () => OneNavigation | null;
    load: () => Promise<void>;
}>((set, get) => ({
    navigation: null,
    refresh: () => {
        let navigation: OneNavigation | null = null;
        try { navigation = read?.() || null; } catch { /* Invalid deployment configuration disables external navigation. */ }
        const previous = get().navigation;
        if (previous?.homeUrl !== navigation?.homeUrl || previous?.rechargeUrl !== navigation?.rechargeUrl || previous?.channel !== navigation?.channel) set({ navigation });
        return navigation;
    },
    load: async () => {
        const config = cloudSession?.navigation;
        if (!config) return;
        try {
            const module = await (loaded ??= import(/* @vite-ignore */ config.moduleUrl));
            if (cloudSession?.navigation !== config) return;
            const { moduleUrl: _url, ...options } = config;
            if (options.policy) options.policy = module.createNavigationPolicy(options.policy.defaults.homeUrl, options.policy.defaults.rechargeUrl, options.policy.productHosts);
            read = () => module.browserNavigation(options);
            get().refresh();
        } catch { read = undefined; get().refresh(); }
    },
}));
