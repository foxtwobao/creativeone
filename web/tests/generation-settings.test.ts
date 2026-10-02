import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AiConfig } from "@/stores/use-config-store";
import { generationRequestSettings } from "../../shared/generation-request";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = globalThis.fetch;
let images: typeof import("@/lib/image-settings");
let videos: typeof import("@/lib/video-settings");
let openai: typeof import("@/services/api/image-adapters/openai");
let canvas: typeof import("@/lib/canvas/canvas-generation-helpers");
let config: AiConfig;
beforeAll(async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://creative.test" } } });
    globalThis.fetch = (async (input) => {
        const path = String(input);
        if (path === "/api/auth/me") return Response.json({ user: { id: "alice" }, csrf: "csrf" });
        if (path === "/api/channels") return Response.json({ channels: [] });
        if (path === "/api/model-authorization") return Response.json(null);
        throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    const { initializeCloud } = await import("@/services/api/cloud");
    await initializeCloud();
    const { defaultConfig } = await import("@/stores/use-config-store");
    config = { ...defaultConfig, size: "3840x2160", videoSize: "9:16", channels: [{
        id: "models", name: "模型", baseUrl: "", apiKey: "", apiFormat: "openai", models: [
            { name: "gpt-image", capability: "image", imageType: "openai" },
            { name: "banana-2k", capability: "image", imageType: "banana" },
            { name: "grok-imagine-image-2.0", capability: "image", imageType: "grok" },
            { name: "seedance", capability: "video", videoType: "seedance" },
            { name: "wan3.0-video-720p", capability: "video", videoType: "wan" },
        ],
    }] };
    images = await import("@/lib/image-settings");
    videos = await import("@/lib/video-settings");
    await (await import("@/i18n")).appLocaleReady;
    openai = await import("@/services/api/image-adapters/openai");
    canvas = await import("@/lib/canvas/canvas-generation-helpers");
});
afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("GPT automatic dimensions omit size at every quality; explicit dimensions stay independent", () => {
    const settings = images.imageSettingsForModel(config, "models::gpt-image");
    const automatic = images.selectImageScale(settings, "auto");
    for (const quality of ["auto", "low", "medium", "high"]) {
        expect(openai.openAiImageParams({ ...config, model: "gpt-image", size: automatic, quality })).not.toHaveProperty("size");
        expect(openai.openAiImageParams({ ...config, model: "gpt-image", quality }).size).toBe("3840x2160");
    }
    const next = images.imageSettingsForModel({ ...config, size: automatic }, "models::gpt-image");
    expect(images.selectImageRatio(next, "16:9")).toBe("1536x864");
    expect(images.imageSettingsForModel({ ...config, size: "16:9", quality: "high" }, "models::gpt-image")).toMatchObject({ scale: "1k", size: "1536x864" });
});

test("switching image types preserves valid settings and reports unsupported resolution or quality", () => {
    expect(images.imageSettingsForModel(config, "models::banana-2k")).toMatchObject({ ratio: "16:9", error: "" });
    expect(images.imageSettingsForModel(config, "models::grok-imagine-image-2.0").error).toContain("分辨率");
    expect(images.imageSettingsForModel({ ...config, size: "2048x1152", quality: "high" }, "models::grok-imagine-image-2.0").error).toContain("画质");
    expect(images.imageSettingsForModel({ ...config, size: "2048x1152", quality: "medium" }, "models::grok-imagine-image-2.0").error).toBe("");
});

test("manual image dimensions align to the same step used by request validation", () => {
    const side = images.alignImageDimension(1025);
    expect(side).toBe(1040);
    expect(openai.openAiImageParams({ ...config, model: "gpt-image", size: `${side}x1024` }).size).toBe("1040x1024");
});

test("image and video preferences and canvas node settings remain separate", () => {
    expect(videos.videoSettingsForModel(config, "models::seedance").ratio).toBe("9:16");
    expect(images.imageSettingsForModel(config, "models::gpt-image").ratio).toBe("16:9");
    const node = { id: "node", type: "config", title: "设置", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { size: "2048x2048", videoSize: "4:3" } };
    expect(canvas.buildGenerationConfig(config, node, "image")).toMatchObject({ size: "2048x2048", videoSize: "4:3" });
    expect(canvas.buildGenerationConfig(config, node, "video")).toMatchObject({ size: "3840x2160", videoSize: "4:3" });
});

test("video panels and requests derive the same mode, switches, duration and WAN restrictions", () => {
    expect(videos.videoSettingsForModel({ ...config, videoGenerateAudio: "false", videoWatermark: "true" }, "models::seedance", 3)).toMatchObject({ mode: "reference", forcedReference: true, generateAudio: false, watermark: true, seconds: "6" });
    expect(videos.videoSettingsForModel(config, "models::seedance", 2).mode).toBe("frames");
    expect(videos.videoSettingsForModel({ ...config, vquality: "1080" }, "models::wan3.0-video-720p")).toMatchObject({ resolution: "720", audioOptions: false });
    expect(videos.videoSettingsForModel({ ...config, videoSize: "4:3" }, "models::wan3.0-video-720p").error).toContain("宽高比");
});

test("history restores submitted image resolution, automatic size, transparency and actual WAN reference mode", () => {
    expect(generationRequestSettings("image", { aspect_ratio: "16:9", resolution: "2k", quality: "medium" })).toMatchObject({ size: "2048x1152", videoSize: "", quality: "medium" });
    expect(generationRequestSettings("image", { background: "transparent" })).toMatchObject({ size: "auto", quality: "auto", background: "transparent" });
    expect(generationRequestSettings("video", { aspect_ratio: "adaptive", reference_images: [{ role: "reference_image" }], seconds: "6" })).toMatchObject({ size: "", videoSize: "auto", videoMode: "reference", videoSeconds: "6" });
});

test("canvas video panel exposes audio and watermark, removes W/H and shows effective reference mode", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { VideoSettingsPanel } = await import("@/components/video-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    const markup = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: { ...config, model: "models::seedance" }, referenceImageCount: 3, theme: canvasThemes.light, onConfigChange: () => {} }));
    expect(markup).toContain('aria-label="生成音频"');
    expect(markup).toContain('aria-label="视频水印"');
    expect(markup).toContain("超过两张图片，已使用参考图模式。");
    expect(markup).not.toContain("↔");
    const wan = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: { ...config, model: "models::wan3.0-video-720p" }, theme: canvasThemes.dark, onConfigChange: () => {} }));
    expect(wan).not.toContain('aria-label="生成音频"');
    expect(wan).toContain("由模型决定");
});

test("model-aware panels show extra GPT quality and single-image Grok follows the reference ratio", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ImageSettingsPanel } = await import("@/components/image-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    const model = "models::gpt-image-2.5-flare";
    const configured = { ...config, model, channels: [{ ...config.channels[0]!, models: [...config.channels[0]!.models, { name: "gpt-image-2.5-flare", capability: "image" as const, imageType: "openai" as const }] }] };
    const markup = renderToStaticMarkup(createElement(ImageSettingsPanel, { config: configured, theme: canvasThemes.light, onConfigChange: () => {} }));
    expect(markup).toContain("极致");
    expect(markup).toContain("超高");
    const grok = renderToStaticMarkup(createElement(ImageSettingsPanel, { config: { ...config, model: "models::grok-imagine-image-2.0", size: "2048x1152" }, referenceImageCount: 1, theme: canvasThemes.dark, onConfigChange: () => {} }));
    expect(grok).toContain("单图编辑沿用参考图片比例");
    expect(grok).not.toContain(">16:9<");
    const restored = generationRequestSettings("image", { image: { url: "reference.png" }, resolution: "2k" });
    const { grokImageBody } = await import("@/services/api/image-adapters/grok");
    const request = grokImageBody("grok-imagine-image-2.0", "edit", restored.size, "auto", 1, ["reference.png"]);
    expect(request.resolution).toBe("2k");
    expect(request).not.toHaveProperty("aspect_ratio");
    expect(images.imageSettingsForModel(configured, model, 17).error).toContain("16 张");
});

test("Seedance panel and history preserve automatic duration and 4k", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { VideoSettingsPanel } = await import("@/components/video-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    const model = "models::doubao-seedance-2-0-260128";
    const configured = { ...config, model, videoSeconds: "-1", vquality: "4k", channels: [{ ...config.channels[0]!, models: [...config.channels[0]!.models, { name: "doubao-seedance-2-0-260128", capability: "video" as const, videoType: "seedance" as const }] }] };
    const markup = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: configured, theme: canvasThemes.light, onConfigChange: () => {} }));
    expect(markup).toContain("4K");
    expect(markup).toContain('aria-label="自动时长"');
    expect(markup).toContain('max="15"');
    expect(markup).not.toContain('min="1"');
    expect(generationRequestSettings("video", { duration: -1, resolution: "4k" })).toMatchObject({ videoSeconds: "-1", vquality: "4k" });
    const { taskSettings } = await import("@/pages/assets/task-details");
    expect(taskSettings({ duration: -1, quality: "max" })).toEqual([{ key: "duration", label: "时长", children: "自动" }, { key: "quality", label: "质量", children: "极致" }]);
});
