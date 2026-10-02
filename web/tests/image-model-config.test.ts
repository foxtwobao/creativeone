import { expect, test } from "bun:test";

test("cloud image types reach model selection and requests without name-based inference", async () => {
    const fetch = globalThis.fetch;
    const window = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://creativeone.test" } } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/model-authorization") return Response.json(null);
        if (path === "/api/auth/me") return Response.json({ user: { id: "user", admin: true }, csrf: "test" });
        if (path === "/api/channels") return Response.json({ channels: [{ id: "channel", name: "图片", capability: "image", is_default: true,
            models: ["banana-looking-alias", "private-alias", "gpt-image-alias", "grok-unconfigured"],
            image_types: { "banana-looking-alias": "openai", "private-alias": "banana", "gpt-image-alias": "grok" },
        }] });
        if (path === "/api/settings") return Response.json({});
        throw new Error(`Unexpected request: ${path}`);
    }) as typeof globalThis.fetch;
    try {
        const { initializeCloud } = await import("../src/services/api/cloud");
        await initializeCloud();
        const { useConfigStore, loadUserSettings, resolveModelRequestConfig, modelImageTypeOf } = await import("../src/stores/use-config-store");
        await loadUserSettings();
        const config = useConfigStore.getState().config;
        expect(modelImageTypeOf(config, "channel::banana-looking-alias")).toBe("openai");
        expect(resolveModelRequestConfig(config, "channel::private-alias").imageType).toBe("banana");
        expect(resolveModelRequestConfig(config, "channel::gpt-image-alias").imageType).toBe("grok");
        expect(resolveModelRequestConfig(config, "channel::grok-unconfigured").imageType).toBeUndefined();
    } finally {
        globalThis.fetch = fetch;
        if (window) Object.defineProperty(globalThis, "window", window); else Reflect.deleteProperty(globalThis, "window");
    }
});
