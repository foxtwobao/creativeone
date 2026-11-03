import { imageModelProfile } from "../../shared/image-models";
import { defaultVideoParameterPresets } from "../../shared/video-models";
import { veoModels } from "../../shared/video-models";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AiConfig } from "@/stores/use-config-store";
import { generationRequestSettings } from "../../shared/generation-request";
import { taskSettings } from "../../shared/task-settings";

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
            { name: "gpt-image", capability: "image", imageType: "openai", imagePreset: "openai-default", imageProfile: imageModelProfile("", "openai") },
            { name: "banana-2k", capability: "image", imageType: "banana", imagePreset: "banana-default", imageProfile: imageModelProfile("", "banana") },
            { name: "grok-imagine-image-2.0", capability: "image", imageType: "grok", imagePreset: "grok-imagine-image-2.0", imageProfile: imageModelProfile("grok-imagine-image-2.0", "grok") },
            { name: "seedance", capability: "video", videoType: "seedance", videoPreset: "doubao-seedance-2-0-260128", videoProfile: defaultVideoParameterPresets["doubao-seedance-2-0-260128"]?.profile },
            { name: "wan3.0-video", capability: "video", videoType: "tokenone", videoPreset: "wan3-standard", videoProfile: defaultVideoParameterPresets["wan3-standard"]?.profile },
            { name: "wan3.0-video-prime", capability: "video", videoType: "tokenone", videoPreset: "wan3-standard", videoProfile: defaultVideoParameterPresets["wan3-standard"]?.profile },
            { name: "MiniMax-H3", capability: "video", videoType: "tokenone", videoPreset: "MiniMax-H3", videoProfile: defaultVideoParameterPresets["MiniMax-H3"]?.profile },
            ...veoModels.map((name) => ({ name, capability: "video" as const, videoType: "tokenone" as const, videoPreset: name, videoProfile: defaultVideoParameterPresets[name]?.profile })),
        ],
    }] };
    images = await import("@/lib/image-settings");
    videos = await import("@/lib/video-settings");
    await (await import("@/i18n")).appLocaleReady;
    const adapter = await import("@/services/api/image-adapters/openai");
    openai = { ...adapter, openAiImageParams: config => adapter.openAiImageParams({ ...config, imageProfile: imageModelProfile(config.model, "openai") }) };
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
    expect(videos.videoSettingsForModel({ ...config, vquality: "1080" }, "models::wan3.0-video")).toMatchObject({ resolution: "1080", audioOptions: false });
    for (const videoSize of ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"]) expect(videos.videoSettingsForModel({ ...config, videoSize }, "models::wan3.0-video").error).toBe("");
    expect(new Set(videos.videoSettingsForModel(config, "models::wan3.0-video").ratios.map((item) => item.value))).toEqual(new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"]));
    expect(videos.videoSettingsForModel({ ...config, videoSize: "2:3" }, "models::wan3.0-video").error).toContain("宽高比");
});

test("history restores submitted image resolution, automatic size, transparency and actual WAN reference mode", () => {
    expect(generationRequestSettings("image", { aspect_ratio: "16:9", resolution: "2k", quality: "medium" })).toMatchObject({ size: "2048x1152", videoSize: "", quality: "medium" });
    expect(generationRequestSettings("image", { background: "transparent" })).toMatchObject({ size: "auto", quality: "auto", background: "transparent" });
    expect(generationRequestSettings("video", { ratio: "adaptive", metadata: { input: { media: [{ type: "reference_image", url: "/ref" }] } }, duration: 6, resolution: "720P" })).toMatchObject({ size: "", videoSize: "auto", videoMode: "reference", videoSeconds: "6" });
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
    const wan = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: { ...config, model: "models::wan3.0-video" }, theme: canvasThemes.dark, onConfigChange: () => {} }));
    expect(wan).not.toContain('aria-label="生成音频"');
    expect(wan).not.toContain('知梦');
    expect(wan).not.toContain('zhimengapi');
    expect(wan).not.toContain("由模型决定");
    expect(wan).toContain("480p");
    expect(wan).toContain("1080p");
    expect(wan).toContain(">4:3<");
    expect(wan).toContain(">3:4<");
    expect(wan).toContain(">21:9<");
    expect(wan).toContain('min="2"');
    expect(wan).toContain('max="30"');
});

test("switching from Seedance automatic duration to WAN preserves -1 and unlocks the duration controls", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { VideoSettingsPanel } = await import("@/components/video-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    const selected = { ...config, model: "models::doubao-seedance-2-0-260128", videoSeconds: "-1", channels: [{ ...config.channels[0]!, models: [...config.channels[0]!.models, { name: "doubao-seedance-2-0-260128", capability: "video" as const, videoType: "seedance" as const, videoPreset: "doubao-seedance-2-0-260128", videoProfile: defaultVideoParameterPresets["doubao-seedance-2-0-260128"]?.profile }] }] };
    const changes: string[] = [];
    const render = (value: AiConfig) => renderToStaticMarkup(createElement(VideoSettingsPanel, { config: value, theme: canvasThemes.light, onConfigChange: (_key, next) => changes.push(next) }));
    const seedance = render(selected);
    expect(seedance).toContain('aria-label="自动时长"');
    expect(seedance.match(/<input\b[^>]*type="number"[^>]*>/)?.[0]).toContain("disabled");
    expect(videos.videoSettingsForModel(selected, selected.model)).toMatchObject({ seconds: "-1", automaticDuration: true });
    const switched = { ...selected, model: "models::wan3.0-video" };
    const wan = render(switched);
    const input = wan.match(/<input\b[^>]*type="number"[^>]*>/)?.[0];
    expect(input).toContain('value="-1"');
    expect(input).not.toContain("disabled");
    expect(wan).not.toContain('aria-disabled="true"');
    expect(wan).not.toContain('aria-label="自动时长"');
    expect(wan).toContain("2–30");
    expect(videos.videoSettingsForModel(switched, switched.model)).toMatchObject({ seconds: "-1", autoSeconds: false, automaticDuration: false });
    expect(videos.videoSettingsForModel({ ...switched, videoSeconds: "6" }, switched.model).error).toBe("");
    expect(changes).toEqual([]);
    expect(selected.videoSeconds).toBe("-1");
});

test("model-aware panels show extra GPT quality and single-image Grok follows the reference ratio", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ImageSettingsPanel } = await import("@/components/image-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    const model = "models::gpt-image-2.5-flare";
    const configured = { ...config, model, channels: [{ ...config.channels[0]!, models: [...config.channels[0]!.models, { name: "gpt-image-2.5-flare", capability: "image" as const, imageType: "openai" as const, imagePreset: "gpt-image-2.5-flare", imageProfile: imageModelProfile("gpt-image-2.5-flare", "openai") }] }] };
    const markup = renderToStaticMarkup(createElement(ImageSettingsPanel, { config: configured, theme: canvasThemes.light, onConfigChange: () => {} }));
    expect(markup).toContain("极致");
    expect(markup).toContain("超高");
    const grok = renderToStaticMarkup(createElement(ImageSettingsPanel, { config: { ...config, model: "models::grok-imagine-image-2.0", size: "2048x1152" }, referenceImageCount: 1, theme: canvasThemes.dark, onConfigChange: () => {} }));
    expect(grok).toContain("单图编辑沿用参考图片比例");
    expect(grok).not.toContain(">16:9<");
    const restored = generationRequestSettings("image", { image: { url: "reference.png" }, resolution: "2k" });
    const { grokImageBody } = await import("@/services/api/image-adapters/grok");
    const request = grokImageBody("grok-imagine-image-2.0", "edit", restored.size, "auto", 1, ["reference.png"], imageModelProfile("grok-imagine-image-2.0", "grok"));
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
    const configured = { ...config, model, videoSeconds: "-1", vquality: "4k", channels: [{ ...config.channels[0]!, models: [...config.channels[0]!.models, { name: "doubao-seedance-2-0-260128", capability: "video" as const, videoType: "seedance" as const, videoPreset: "doubao-seedance-2-0-260128", videoProfile: defaultVideoParameterPresets["doubao-seedance-2-0-260128"]?.profile }] }] };
    const markup = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: configured, theme: canvasThemes.light, onConfigChange: () => {} }));
    expect(markup).toContain("4K");
    expect(markup).toContain('aria-label="自动时长"');
    expect(markup).toContain('max="15"');
    expect(markup).not.toContain('min="1"');
    expect(generationRequestSettings("video", { duration: -1, resolution: "4k" })).toMatchObject({ videoSeconds: "-1", vquality: "4k" });
    const { taskSettings } = await import("@/pages/assets/task-details");
    expect(taskSettings({ duration: -1, quality: "max" })).toEqual([{ key: "duration", label: "时长", children: "自动" }, { key: "quality", label: "质量", children: "极致" }]);
});

test("H3 displays 768P and 2K, reports manually entered invalid values and requires an explicit reference mode", async () => {
    const model = "models::MiniMax-H3";
    const selected = { ...config, model, vquality: "768", videoSeconds: "4", videoSize: "16:9", videoMode: "frames" };
    expect(videos.videoSettingsForModel({ ...selected, vquality: "720" }, model).error).toContain("分辨率");
    expect(videos.videoSettingsForModel({ ...selected, videoSeconds: "-1" }, model)).toMatchObject({ seconds: "-1", automaticDuration: false, autoSeconds: false });
    expect(videos.videoSettingsForModel(selected, model, 3)).toMatchObject({ mode: "frames", forcedReference: false });
    expect(videos.videoSettingsForModel(selected, model, 3).error).toContain("不能混用");
    expect(videos.videoSettingsForModel({ ...selected, videoMode: "reference", vquality: "2K" }, model, 9, { videos: [{ durationMs: 6000 }], audios: [{ durationMs: 173000 }] })).toMatchObject({ error: "", resolution: "2k", audioOptions: false, secondsRange: { min: 4, max: 15, auto: false } });
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { VideoSettingsPanel } = await import("@/components/video-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    for (const count of [5, 6, 9]) {
        const markup = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: { ...selected, videoMode: "reference" }, referenceImageCount: count, theme: canvasThemes.dark, onConfigChange: () => {} }));
        expect(markup).toContain("2K");
        expect(markup).toContain("768p");
        expect(markup).toContain(">21:9<");
        expect(markup).toContain(`本次额外参考图：${Math.max(count - 5, 0)} 张`);
        expect(markup).toContain("使用推荐参数");
        expect(markup).not.toContain("知梦");
        expect(markup).not.toContain("zhimengapi");
        expect(markup).not.toContain('aria-label="生成音频"');
    }
});

test("selecting H3 repairs incompatible WAN parameters in one state update and one saved patch", async () => {
    const { useConfigStore } = await import("@/stores/use-config-store");
    const { getAccountResource } = await import("@/services/api/account");
    const { videoRequestBody } = await import("../../shared/video-request");
    const fetch = globalThis.fetch, previous = useConfigStore.getState().config;
    const model = "models::MiniMax-H3";
    const saved: Partial<AiConfig> = { videoModel: "models::wan3.0-video", vquality: "720", videoSeconds: "2", videoSize: "9:16", videoMode: "reference" };
    const patches: unknown[] = [], states: AiConfig[] = [];
    let savedPatch!: () => void;
    const savedRequest = new Promise<void>((resolve) => { savedPatch = resolve; });
    globalThis.fetch = (async (input, init) => {
        if (String(input) !== "/api/settings") throw new Error(`Unexpected request: ${input}`);
        if (init?.method === "PATCH") {
            const patch = JSON.parse(String(init.body));
            patches.push(patch); Object.assign(saved, patch); savedPatch();
        }
        return Response.json(saved);
    }) as typeof fetch;
    useConfigStore.setState({ config: { ...config, ...saved } });
    const unsubscribe = useConfigStore.subscribe((state) => states.push(state.config));
    try {
        useConfigStore.getState().updateConfig("videoModel", model);
        await savedRequest;
        expect(await getAccountResource("/settings")).toMatchObject({ videoModel: model, vquality: "768", videoSeconds: "4", videoSize: "9:16", videoMode: "reference" });
        expect(patches).toEqual([{ videoModel: model, vquality: "768", videoSeconds: "4" }]);
        expect(states).toHaveLength(1);
        const selected = states[0]!;
        expect(videos.videoSettingsForModel(selected, model).error).toBe("");
        expect(videoRequestBody("MiniMax-H3", { callType: "tokenone", preset: "MiniMax-H3", profile: defaultVideoParameterPresets["MiniMax-H3"]?.profile }, "生成短片", { images: [], videos: [], audios: [] }, { seconds: selected.videoSeconds, resolution: selected.vquality, ratio: selected.videoSize, mode: selected.videoMode, generateAudio: true, watermark: true })).toEqual({ model: "MiniMax-H3", prompt: "生成短片", duration: 4, resolution: "768P", ratio: "9:16" });
        expect(selected.size).toBe(config.size);
    } finally {
        unsubscribe(); globalThis.fetch = fetch;
        useConfigStore.setState({ config: previous });
    }
});

test("H3 selection keeps compatible values, repairs unsupported ratios and repairs other model transitions", async () => {
    const { videoModelSelectionPatch } = await import("@/stores/use-config-store");
    const selected = { ...config, videoModel: "models::wan3.0-video", vquality: "2K", videoSeconds: "15", videoSize: "auto" };
    expect(videoModelSelectionPatch(selected, "models::MiniMax-H3")).toEqual({});
    for (const videoSeconds of ["-1", "2", "30", "4.5", "invalid", ""]) {
        expect(videoModelSelectionPatch({ ...selected, videoSeconds, videoSize: "2:3" }, "models::MiniMax-H3")).toEqual({ videoSeconds: "4", videoSize: "16:9" });
    }
    expect(videoModelSelectionPatch({ ...selected, videoSeconds: "-1" }, "models::wan3.0-video")).toEqual({ vquality: "720", videoSeconds: "6" });
    expect(videoModelSelectionPatch(selected, "models::seedance")).toEqual({ vquality: "720" });
});

test("canvas H3 selection saves defaults to node fields and the resulting request matches the panel", () => {
    const node = { id: "node", type: "config", title: "设置", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "models::wan3.0-video", seconds: "30", vquality: "1080", videoSize: "3:4", videoMode: "reference", prompt: "生成短片" } };
    const current = canvas.buildGenerationConfig(config, node, "video");
    const patch = canvas.canvasVideoModelPatch(current, "models::MiniMax-H3");
    const next = { ...node, metadata: { ...node.metadata, ...patch } };
    const selected = canvas.buildGenerationConfig(config, next, "video");
    expect(patch).toEqual({ model: "models::MiniMax-H3" });
    expect(videos.videoSettingsForModel(selected, selected.model, 3)).toMatchObject({ error: "", ratio: "3:4", seconds: "30", resolution: "1080", mode: "reference" });
    expect(next.metadata.prompt).toBe(node.metadata.prompt);
    expect(config.vquality).toBe("720");
});

test("H3 to WAN repairs resolution while retaining supported ratio, duration and reference mode", async () => {
    const { useConfigStore } = await import("@/stores/use-config-store");
    const { getAccountResource } = await import("@/services/api/account");
    const { videoRequestBody } = await import("../../shared/video-request");
    const fetch = globalThis.fetch, previous = useConfigStore.getState().config;
    try {
        for (const model of ["models::wan3.0-video", "models::wan3.0-video-prime"]) for (const vquality of ["768", "2K"]) {
            const saved = { ...config, videoModel: "models::MiniMax-H3", vquality, videoSeconds: "15", videoSize: "21:9", videoMode: "reference" };
            const patches: unknown[] = [], states: AiConfig[] = [];
            let savedPatch!: () => void;
            const savedRequest = new Promise<void>((resolve) => { savedPatch = resolve; });
            globalThis.fetch = (async (input, init) => {
                if (String(input) !== "/api/settings") throw new Error(`Unexpected request: ${input}`);
                if (init?.method === "PATCH") {
                    const patch = JSON.parse(String(init.body));
                    patches.push(patch); Object.assign(saved, patch); savedPatch();
                }
                return Response.json(saved);
            }) as typeof fetch;
            useConfigStore.setState({ config: saved });
            const unsubscribe = useConfigStore.subscribe((state) => states.push(state.config));
            try {
                useConfigStore.getState().updateConfig("videoModel", model);
                await savedRequest;
                expect(await getAccountResource("/settings")).toMatchObject({ videoModel: model, vquality: "720", videoSize: "21:9", videoSeconds: "15", videoMode: "reference" });
                expect(patches).toEqual([{ videoModel: model, vquality: "720" }]);
                expect(states).toHaveLength(1);
                const selected = states[0]!;
                expect(videos.videoSettingsForModel(selected, model, 9, { videos: [{ durationMs: 6000 }], audios: [{}] }).error).toBe("");
                const body = videoRequestBody(model.split("::")[1]!, { callType: "tokenone", preset: "wan3-standard", profile: defaultVideoParameterPresets["wan3-standard"]?.profile }, "生成短片", { images: ["https://example.com/image.png"], videos: ["https://example.com/video.mp4"], audios: ["https://example.com/audio.mp3"] }, { seconds: selected.videoSeconds, resolution: selected.vquality, ratio: selected.videoSize, mode: selected.videoMode, generateAudio: true, watermark: true });
                expect(body).toMatchObject({ duration: 15, resolution: "720P", ratio: "21:9", metadata: { input: { media: [
                    { type: "reference_image", url: "https://example.com/image.png" },
                    { type: "reference_video", url: "https://example.com/video.mp4" },
                    { type: "reference_audio", url: "https://example.com/audio.mp3" },
                ] } } });
                expect(selected.size).toBe(config.size);
            } finally { unsubscribe(); }
        }
    } finally { globalThis.fetch = fetch; useConfigStore.setState({ config: previous }); }
});

test("WAN return keeps supported values and repairs invalid duration on model selection", async () => {
    const { videoModelSelectionPatch } = await import("@/stores/use-config-store");
    const selected = { ...config, videoModel: "models::MiniMax-H3", vquality: "720", videoSeconds: "4" };
    for (const videoSize of ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"]) {
        expect(videoModelSelectionPatch({ ...selected, videoSize }, "models::wan3.0-video")).toEqual({});
    }
    expect(videoModelSelectionPatch({ ...selected, videoSeconds: "-1" }, "models::wan3.0-video")).toEqual({ videoSeconds: "6" });
});

test("canvas WAN return uses the node's H3 model instead of the workspace model", () => {
    const workspace = { ...config, videoModel: "models::wan3.0-video" };
    const node = { id: "node", type: "config", title: "设置", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "models::MiniMax-H3", seconds: "4", vquality: "2K", videoSize: "21:9", videoMode: "frames", prompt: "生成短片" } };
    const patch = canvas.canvasVideoModelPatch(canvas.buildGenerationConfig(workspace, node, "video"), "models::wan3.0-video");
    expect(patch).toEqual({ model: "models::wan3.0-video", vquality: "720" });
    const selected = canvas.buildGenerationConfig(workspace, { ...node, metadata: { ...node.metadata, ...patch } }, "video");
    expect(videos.videoSettingsForModel(selected, selected.model, 2)).toMatchObject({ error: "", seconds: "4", resolution: "720", ratio: "21:9", mode: "frames" });
    expect(workspace.vquality).toBe("720");
});

test("H3 history preserves explicit mode, resolution and duration independently of current preferences", () => {
    for (const resolution of ["768P", "2K"]) {
        expect(generationRequestSettings("video", { resolution, duration: 15, ratio: "21:9", metadata: { input: { media: [{ type: "reference_audio", url: "/ref" }] } } })).toMatchObject({ videoMode: "reference", vquality: resolution === "2K" ? "2k" : "768", videoSeconds: "15", videoSize: "21:9" });
    }
    expect(generationRequestSettings("video", { resolution: "768P", duration: 4, metadata: { input: { media: [{ type: "first_frame", url: "/ref" }] } } })).toMatchObject({ videoMode: "frames", vquality: "768", videoSeconds: "4" });
});

test("Veo / Omni selection repairs only incompatible fields and supports round trips in workbench and canvas", async () => {
    const { videoModelSelectionPatch } = await import("@/stores/use-config-store");
    let selected = { ...config, videoModel: "models::MiniMax-H3", vquality: "2k", videoSize: "21:9", videoSeconds: "15", videoMode: "frames" };
    const choose = (model: string) => {
        const patch = videoModelSelectionPatch(selected, model);
        selected = { ...selected, ...patch, videoModel: model };
        expect(videos.videoSettingsForModel(selected, model).error).toBe("");
        return patch;
    };
    expect(choose("models::omni-flash-video")).toEqual({ vquality: "720", videoSize: "16:9", videoMode: "reference" });
    expect(choose("models::veo-3.1-1080p")).toEqual({ vquality: "1080", videoMode: "frames" });
    expect(choose("models::veo-3.1-fast")).toEqual({ vquality: "720" });
    expect(choose("models::wan3.0-video")).toEqual({});
    expect(choose("models::MiniMax-H3")).toEqual({ vquality: "768" });
    expect(selected.videoSeconds).toBe("15");
    const workspace = { ...config, videoModel: "models::wan3.0-video" };
    const node = { id: "veo-node", type: "video", title: "设置", position: { x: 0, y: 0 }, width: 240, height: 135, metadata: { model: "models::MiniMax-H3", seconds: "4", vquality: "2k", videoSize: "21:9", videoMode: "frames", prompt: "短片", references: ["image:keep"] } };
    const patch = canvas.canvasVideoModelPatch(canvas.buildGenerationConfig(workspace, node, "video"), "models::omni-flash-video");
    expect(patch).toEqual({ model: "models::omni-flash-video", vquality: "720", videoSize: "16:9", videoMode: "reference" });
    const switched = { ...node, metadata: { ...node.metadata, ...patch } };
    const back = canvas.canvasVideoModelPatch(canvas.buildGenerationConfig(workspace, switched, "video"), "models::MiniMax-H3");
    expect(back).toEqual({ model: "models::MiniMax-H3", vquality: "768" });
    expect(switched.metadata.references).toEqual(["image:keep"]);
    expect(switched.metadata.seconds).toBe("4");
});

test("Veo / Omni panels expose fixed quality, supported modes and material rules without duration or audio switches", async () => {
    const { videoModelSelectionPatch } = await import("@/stores/use-config-store");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { VideoSettingsPanel } = await import("@/components/video-settings-panel");
    const { canvasThemes } = await import("@/lib/canvas-theme");
    for (const name of veoModels) {
        const model = `models::${name}`;
        const selected = { ...config, ...videoModelSelectionPatch(config, model), model, videoModel: model };
        const settings = videos.videoSettingsForModel(selected, model);
        expect(settings).toMatchObject({ error: "", durationConfigurable: false, audioOptions: false, durationLabel: "模型决定时长", modeLabel: "文生视频" });
        expect(settings.ratios.map((item) => item.value)).toEqual(["16:9", "9:16"]);
        expect(settings.resolutions).toHaveLength(1);
        for (const theme of [canvasThemes.light, canvasThemes.dark]) {
            const markup = renderToStaticMarkup(createElement(VideoSettingsPanel, { config: selected, theme, onConfigChange: () => { throw new Error("render must not mutate preferences"); } }));
            expect(markup).toContain("时长由模型决定");
            expect(markup).not.toContain('type="number"');
            expect(markup).not.toContain('aria-label="生成音频"');
            expect(markup).not.toContain('aria-label="视频水印"');
            expect(markup).not.toContain(">1:1<");
            expect(markup).toContain(name === "omni-flash-video" ? "1–3 张图片" : name === "veo-3.1-fast-1080p" ? "最多 0 张" : "可使用首帧或首尾帧");
        }
    }
    const model = "models::veo-3.1-fast";
    expect(videos.videoSettingsForModel({ ...config, videoMode: "reference" }, model, 2).error).toContain("恰好 3 张");
    expect(videos.videoSettingsForModel(config, model, 3).error).toContain("不能混用");
    expect(videos.videoSettingsForModel({ ...config, videoMode: "reference" }, model, 3)).toMatchObject({ mode: "reference", error: "" });
});

test("Veo history restores public parameters and media roles without inventing duration", () => {
    const request = { resolution: "1080P", ratio: "9:16", metadata: { input: { media: [{ type: "reference_image", url: "/ref" }] } } };
    expect(generationRequestSettings("video", request)).toMatchObject({ videoSize: "9:16", vquality: "1080", videoMode: "reference", videoSeconds: "" });
    expect(taskSettings(request)).toContainEqual({ key: "images", label: "参考图片", children: "1 个" });
});

test("Veo canvas defaults match the authoritative request when an Agent omits node parameters", async () => {
    const { canvasRequestBody } = await import("../../shared/canvas-request");
    const { videoRequestBody } = await import("../../shared/video-request");
    for (const model of veoModels) {
        const node = { id: "node", type: "video", title: "短片", position: { x: 0, y: 0 }, width: 240, height: 135, metadata: { model: `models::${model}`, prompt: "画面" } };
        const current = canvas.buildGenerationConfig({ ...config, videoSize: "1:1", vquality: "2k", videoMode: "reference" }, node, "video");
        const settings = videos.videoSettingsForModel(current, current.model);
        expect(settings.error).toBe("");
        const refs = { images: [], videos: [], audios: [] };
        expect(videoRequestBody(model, { callType: "tokenone", preset: model, profile: defaultVideoParameterPresets[model]?.profile }, "画面", refs, { seconds: settings.seconds, resolution: settings.resolution, ratio: settings.ratio, mode: settings.mode, generateAudio: false, watermark: false })).toEqual(canvasRequestBody(model, "video", "veo", node.metadata, refs, "", "", { callType: "tokenone", preset: model, profile: defaultVideoParameterPresets[model]?.profile }));
    }
});

test("video switches use preset defaults but preserve valid explicit choices", async () => {
    const { videoModelProfile, videoSwitchSettings } = await import("../../shared/video-models");
    const base = videoModelProfile("doubao-seedance-2-0-260128", "seedance");
    const profile = { ...base, fastModeOptions: ["", "false", "true"], defaults: { ...base.defaults, generateAudio: false, watermark: true, fastMode: "false" } };
    expect(videoSwitchSettings(profile, { generateAudio: "invalid", watermark: "invalid", fastMode: "invalid" })).toEqual({ generateAudio: false, watermark: true, fastMode: false });
    expect(videoSwitchSettings(profile, { generateAudio: "true", watermark: "false", fastMode: "true" })).toEqual({ generateAudio: true, watermark: false, fastMode: true });
});

test("maintained image profiles drive workbench options, canvas defaults and model switching", async () => {
    const { imageModelSelectionPatch } = await import("@/stores/use-config-store");
    const profile = structuredClone(imageModelProfile("", "openai"));
    profile.qualities = ["auto", "custom-quality"];
    profile.defaults = { size: "1:1", quality: "custom-quality", background: "" };
    profile.pixelBounds.step = 8;
    profile.sizePresets["1k"]["1:1"] = "1000x1000";
    const model = "models::maintained-alias";
    const configured: AiConfig = { ...config, channels: [{ ...config.channels[0]!, models: [...config.channels[0]!.models, { name: "maintained-alias", capability: "image", imageType: "openai", imagePreset: "database-id", imageProfile: profile }] }] };
    const settings = images.imageSettingsForModel({ ...configured, size: "auto", quality: "custom-quality" }, model);
    expect(settings.qualities.map(item => item.value)).toEqual(["auto", "custom-quality"]);
    expect(images.selectImageRatio(settings, "1:1")).toBe("1000x1000");
    expect(images.alignImageDimension(1001, settings.profile!.pixelBounds.step)).toBe(1008);
    expect(imageModelSelectionPatch(configured, model)).toEqual({});
    const patch = imageModelSelectionPatch({ ...configured, quality: "high" }, model);
    expect(patch).toEqual({ quality: "custom-quality" });
    expect(imageModelSelectionPatch({ ...configured, ...patch }, "models::gpt-image")).toEqual({ quality: "auto" });
    const node = { id: "image", type: "image", title: "画面", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model } };
    expect(canvas.buildGenerationConfig(configured, node, "image")).toMatchObject({ model, quality: "custom-quality", size: "1:1" });
});
