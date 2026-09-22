import { createUserStore } from "@/services/cloud-storage";

import type { PluginStorage } from "@/types/canvas-plugin";

// Lightweight canvas event bus for communication between nodes and plugins.
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function emitCanvasEvent(event: string, payload?: unknown) {
    handlers.get(event)?.forEach((handler) => {
        try {
            handler(payload);
        } catch (error) {
            console.error(`[canvas-event] handler for "${event}" failed`, error);
        }
    });
}

export function onCanvasEvent(event: string, handler: Handler) {
    let set = handlers.get(event);
    if (!set) {
        set = new Set();
        handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
}

// Plugin keys remain isolated within the current user's cloud documents.
export function createPluginStorage(pluginId: string): PluginStorage {
    const store = createUserStore("app_state");
    const name = (key: string) => `plugin:${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([pluginId, key])))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    return {
        get: (key) => store.getItem(name(key)),
        set: async (key, value) => { await store.setItem(name(key), value); },
        remove: (key) => store.removeItem(name(key)),
    };
}
