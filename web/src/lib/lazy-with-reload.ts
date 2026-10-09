import { lazy, type ComponentType } from "react";

const CHUNK_RELOAD_KEY = "creativeone:chunk-reload";

export function lazyWithReload<T extends { default: ComponentType<any> }>(load: () => Promise<T>) {
    return lazy(async () => {
        try {
            const module = await load();
            sessionStorage.removeItem(CHUNK_RELOAD_KEY);
            return module;
        } catch (error) {
            if (sessionStorage.getItem(CHUNK_RELOAD_KEY) !== "1") {
                sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
                window.location.reload();
                return new Promise<T>(() => {});
            }
            throw error;
        }
    });
}
