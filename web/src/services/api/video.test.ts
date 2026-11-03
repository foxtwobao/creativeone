import { defaultVideoParameterPresets } from "../../../../shared/video-models";
import { veoModels } from "../../../../shared/video-models";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import axios from "axios";
import { initializeCloud } from "./cloud";
import type { AiConfig } from "@/stores/use-config-store";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let api: typeof import("./video");
let settings: typeof import("@/lib/video-settings");
let config: AiConfig;
const signed: { namespace: string; key: string }[] = [];
const mocks: { mockRestore(): void }[] = [];
beforeAll(async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://creative.test" }, setTimeout, clearTimeout } });
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path.startsWith("data:")) return originalFetch(input, init);
        if (path === "/api/auth/me") return Response.json({ user: { id: "alice" }, csrf: "csrf", maxReferenceImageBytes: 10485760 });
        if (path === "/api/channels") return Response.json({ channels: [] });
        if (path === "/api/model-authorization") return Response.json(null);
        if (path === "/api/files/info") return Response.json({ bytes: 1024 });
        if (path === "/api/files/sign") {
            const item = JSON.parse(String(init?.body));
            signed.push(item);
            return Response.json({ url: `https://creative.test/signed/${item.key}` });
        }
        if (path.startsWith("/api/storage/")) return Response.json({ entries: [] });
        throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    await initializeCloud();
    const { defaultConfig } = await import("@/stores/use-config-store");
    config = { ...defaultConfig, model: "video::wan3.0-video", size: "4:3", videoSize: "auto", channels: [{
        id: "video", name: "Video", baseUrl: "https://creative.test/api/ai/video/v1", apiKey: "csrf", apiFormat: "openai",
        models: [
            { name: "wan3.0-video", capability: "video", videoType: "tokenone", videoPreset: "wan3-standard", videoProfile: defaultVideoParameterPresets["wan3-standard"]?.profile },
            { name: "wan3.0-image-1080p", capability: "video", videoType: "tokenone", videoPreset: "missing-preset", videoProfile: defaultVideoParameterPresets["missing-preset"]?.profile },
            { name: "doubao-seedance-2-0-260128", capability: "video", videoType: "seedance", videoPreset: "doubao-seedance-2-0-260128", videoProfile: defaultVideoParameterPresets["doubao-seedance-2-0-260128"]?.profile },
            { name: "doubao-seedance-2-5-260628", capability: "video", videoType: "seedance", videoPreset: "doubao-seedance-2-5-260628", videoProfile: defaultVideoParameterPresets["doubao-seedance-2-5-260628"]?.profile },
            { name: "seedance", capability: "video", videoType: "seedance", videoPreset: "doubao-seedance-2-0-260128", videoProfile: defaultVideoParameterPresets["doubao-seedance-2-0-260128"]?.profile },
            { name: "MiniMax-H3", capability: "video", videoType: "tokenone", videoPreset: "MiniMax-H3", videoProfile: defaultVideoParameterPresets["MiniMax-H3"]?.profile },
            ...veoModels.map((name) => ({ name, capability: "video" as const, videoType: "tokenone" as const, videoPreset: name, videoProfile: defaultVideoParameterPresets[name]?.profile })),
        ],
    }] };
    api = await import("./video");
    settings = await import("@/lib/video-settings");
});
afterEach(() => { mocks.splice(0).forEach((mock) => mock.mockRestore()); signed.length = 0; });
afterAll(() => {
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of [["localStorage", originalStorage], ["window", originalWindow]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("WAN submits owned file references without downloading or signing media in the browser", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { code: 0, data: { id: "wan-task" } } }); mocks.push(post);
    const task = await api.createVideoGenerationTask({ ...config, videoMode: "reference" }, "镜头向前", [{ id: "i", name: "image", type: "image/png", dataUrl: "", storageKey: "image:one" }], {
        videos: [{ id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:video" }],
        audios: [{ id: "a", name: "audio", type: "audio/mp3", url: "", storageKey: "file:audio" }],
    });
    expect(task).toEqual({ id: "wan-task", path: "videos", model: config.model });
    expect(post.mock.calls[0]![0]).toEndWith("/v1/videos");
    expect(post.mock.calls[0]![1]).toEqual({ model: "wan3.0-video", prompt: "镜头向前", duration: 6, resolution: "720P", ratio: "adaptive",
        metadata: { input: { media: [
            { type: "reference_image", url: "/api/files/image_files/image%3Aone" },
            { type: "reference_video", url: "/api/files/media_files/file%3Avideo" },
            { type: "reference_audio", url: "/api/files/media_files/file%3Aaudio" },
        ] } },
    });
    expect(signed).toHaveLength(0);
    expect(settings.videoSettingsForModel({ ...config, vquality: "1080" }, config.model)).toMatchObject({ ratio: "auto", resolution: "1080", resolutions: [{value: "480", label: "480p"}, {value: "720", label: "720p"}, {value: "1080", label: "1080p"}] });
});

test("unconfigured video presets are rejected before creating or signing", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    const imageConfig = { ...config, model: "video::wan3.0-image-1080p" };
    await expect(api.createVideoGenerationTask(imageConfig, "prompt")).rejects.toThrow("参数预设");
    await expect(api.createVideoGenerationTask(imageConfig, "prompt", [], { videos: [{ id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:video" }] })).rejects.toThrow("参数预设");
    expect(post).not.toHaveBeenCalled();
    expect(signed).toHaveLength(0);
});

test("Veo / Omni submits strict JSON and explicit image modes through the public video task endpoint", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "veo-task", status: "queued" } }); mocks.push(post);
    for (const [model, resolution, videoMode, count, generation_mode] of [
        ["veo-3.1-lite", "720", "frames", 0, "text", "720x1280"],
        ["veo-3.1", "720", "frames", 1, "first_frame", "720x1280"],
        ["veo-3.1-1080p", "1080", "frames", 2, "first_last", "1080x1920"],
        ["veo-3.1-fast", "720", "reference", 3, "reference", "720x1280"],
        ["veo-3.1-fast-1080p", "1080", "frames", 0, "text", "1080x1920"],
        ["omni-flash-video", "720", "reference", 1, "reference", "720x1280"],
    ] as const) {
        const references = Array.from({ length: count }, (_, i) => ({ id: String(i), name: "图", type: "image/png", dataUrl: "", storageKey: `image:${i}` }));
        const selected = { ...config, model: `video::${model}`, videoSize: "9:16", videoSeconds: "15", vquality: resolution, videoMode };
        expect(await api.createVideoGenerationTask(selected, "短片", references)).toEqual({ id: "veo-task", path: "videos", model: selected.model });
        expect(post.mock.calls.at(-1)![0]).toEndWith("/v1/videos");
        expect(post.mock.calls.at(-1)![1]).toEqual({ model, prompt: "短片", resolution: `${resolution}P`, ratio: "9:16", ...(count ? { metadata: { input: { media: references.map((_, i) => ({ type: generation_mode === "reference" ? "reference_image" : i === 0 ? "first_frame" : "last_frame", url: `/api/files/image_files/image%3A${i}` })) } } } : {}) });
    }
    expect(signed).toHaveLength(0);
});

test("Veo / Omni rejects unsupported media and invalid reference counts before uploading or creating", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    const selected = { ...config, model: "video::veo-3.1-fast", videoSize: "16:9", videoMode: "reference" };
    const image = { id: "i", name: "图", type: "image/png", dataUrl: "", storageKey: "image:owned" };
    await expect(api.createVideoGenerationTask(selected, "短片", [image])).rejects.toThrow("恰好 3 张");
    await expect(api.createVideoGenerationTask(selected, "短片", [], { videos: [{ id: "v", name: "视频", type: "video/mp4", url: "" }] })).rejects.toThrow("不支持参考视频");
    await expect(api.createVideoGenerationTask(selected, "短片", [], { audios: [{ id: "a", name: "音频", type: "audio/mp3", url: "" }] })).rejects.toThrow("0 个参考音频");
    expect(post).not.toHaveBeenCalled();
});

test("Seedance retains its endpoint, numeric duration, ratio and audio switches", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "seedance-task" } }); mocks.push(post);
    expect(await api.createVideoGenerationTask({ ...config, model: "video::seedance", videoSize: "4:3" }, "prompt")).toMatchObject({ path: "contents/generations/tasks" });
    expect(post.mock.calls[0]![0]).toEndWith("/contents/generations/tasks");
    expect(post.mock.calls[0]![1]).toEqual({ model: "seedance", content: [{ type: "text", text: "prompt" }], duration: 6, resolution: "720p", ratio: "4:3", generate_audio: true, watermark: false });
    expect(signed).toHaveLength(0);
});

test("Seedance submits three images as references with the displayed audio switches", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "seedance-task" } }); mocks.push(post);
    const references = [0, 1, 2].map((index) => ({ id: String(index), name: "参考图", type: "image/png", dataUrl: "data:image/png;base64,YQ==" }));
    await api.createVideoGenerationTask({ ...config, model: "video::seedance", videoSize: "9:16", videoGenerateAudio: "false", videoWatermark: "true" }, "prompt", references);
    const body = post.mock.calls[0]![1] as any;
    expect(body).toMatchObject({ ratio: "9:16", generate_audio: false, watermark: true });
    expect(body.content.slice(1).map((item: any) => item.role)).toEqual(["reference_image", "reference_image", "reference_image"]);
});

test("WAN rejects a preserved unsupported ratio before submitting or uploading references", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    await expect(api.createVideoGenerationTask({ ...config, videoSize: "2:3" }, "prompt")).rejects.toThrow("宽高比");
    expect(post).not.toHaveBeenCalled();
});

test("WAN preserves supported ratios including 21:9 and maps the automatic ratio to adaptive", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "wan-ratio" } }); mocks.push(post);
    for (const videoSize of ["4:3", "3:4", "21:9", "auto"]) {
        await api.createVideoGenerationTask({ ...config, videoSize }, "prompt");
        expect(post.mock.calls.at(-1)![1]).toMatchObject({ ratio: videoSize === "auto" ? "adaptive" : videoSize });
    }
});

test("WAN rejects inherited automatic duration and submits only after a manual duration change", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "wan-manual-duration" } }); mocks.push(post);
    const selected = { ...config, videoSeconds: "-1" };
    await expect(api.createVideoGenerationTask(selected, "prompt")).rejects.toThrow("2–30");
    expect(post).not.toHaveBeenCalled();
    expect(selected.videoSeconds).toBe("-1");
    await expect(api.createVideoGenerationTask({ ...selected, videoSeconds: "6" }, "prompt")).resolves.toMatchObject({ id: "wan-manual-duration", path: "videos" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toMatchObject({ duration: 6 });
});

test("resuming WAN reads server file metadata without downloading or uploading the video", async () => {
    const file = { url: "/api/files/media_files/file:completed", storageKey: "file:completed", bytes: 4915678, mimeType: "video/mp4", width: 960, height: 960, durationMs: 4000 };
    const get = spyOn(axios, "get").mockResolvedValue({ data: { code: 0, data: { id: "wan-task", status: "completed", file } } }); mocks.push(get);
    expect(await api.waitForVideoGenerationTask({ ...config, model: "video::seedance" }, { id: "wan-task", path: "videos", model: config.model })).toEqual(file);
    expect(get.mock.calls[0]![0]).toEndWith("/v1/videos/wan-task");
    expect(get).toHaveBeenCalledTimes(1);
    // No document/media element exists, and the fetch mock rejects all media uploads.
});

test("a completed response without a stored file never falls back to client download or upload", async () => {
    const get = spyOn(axios, "get").mockResolvedValue({ data: { status: "completed", metadata: { url: "https://upstream.test/video.mp4" } } }); mocks.push(get);
    await expect(api.pollVideoGenerationTask(config, { id: "wan-task", path: "videos", model: config.model })).rejects.toThrow("服务端尚未返回");
    expect(get).toHaveBeenCalledTimes(1);
});

test("WAN foreground deadline aborts an in-flight query without submitting another task", async () => {
    let expire: (() => void) | undefined;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, milliseconds: number) => {
        expect(milliseconds).toBe(15 * 60_000);
        expire = callback;
        return 1;
    }) as typeof setTimeout); mocks.push(timer);
    const get = spyOn(axios, "get").mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener!("abort", () => reject(new Error("aborted")));
    })); mocks.push(get);
    const post = spyOn(axios, "post"); mocks.push(post);
    const waiting = api.waitForVideoGenerationTask(config, { id: "wan-task", path: "videos", model: config.model });
    expire!();
    await expect(waiting).rejects.toThrow("后台任务不受影响");
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
});

test("WAN and Seedance poll local status every five seconds", async () => {
    const file = { url: "/api/files/media_files/file:one", storageKey: "file:one", bytes: 10, mimeType: "video/mp4" };
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, milliseconds: number) => {
        if (milliseconds !== 15 * 60_000) { expect(milliseconds).toBe(5000); queueMicrotask(callback); }
        return 1;
    }) as typeof setTimeout); mocks.push(timer);
    const get = spyOn(axios, "get"); mocks.push(get);
    for (const path of ["videos", "contents/generations/tasks"] as const) {
        get.mockResolvedValueOnce({ data: { status: "queued" } }).mockResolvedValueOnce({ data: { status: path === "videos" ? "completed" : "succeeded", file } });
        expect(await api.waitForVideoGenerationTask(config, { id: "existing", path, model: config.model })).toEqual(file);
    }
    expect(get).toHaveBeenCalledTimes(4);
});

test("paused tasks require explicit resume and never resubmit generation", async () => {
    const get = spyOn(axios, "get").mockResolvedValue({ data: { status: "paused", error: { message: "后台下载暂时失败" } } }); mocks.push(get);
    const post = spyOn(axios, "post").mockResolvedValue({ data: { status: "queued" } }); mocks.push(post);
    const task = { id: "existing", path: "videos" as const, model: config.model };
    await expect(api.waitForVideoGenerationTask(config, task)).rejects.toThrow("后台下载暂时失败");
    expect(post).not.toHaveBeenCalled();
    await api.resumeVideoGenerationTask(config, task);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toEndWith("/videos/existing/resume");
});


test("Seedance model switching preserves invalid duration and blocks submission before media reads", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    const selected = { ...config, model: "video::doubao-seedance-2-0-260128", videoSeconds: "30" };
    expect(settings.videoSettingsForModel(selected, selected.model)).toMatchObject({ seconds: "30", secondsRange: { min: 4, max: 15 } });
    await expect(api.createVideoGenerationTask(selected, "prompt")).rejects.toThrow("4–15");
    expect(post).not.toHaveBeenCalled();
});

test("Seedance supports native 4k and automatic duration without adding a p suffix", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "task" } }); mocks.push(post);
    await api.createVideoGenerationTask({ ...config, model: "video::doubao-seedance-2-0-260128", vquality: "4k", videoSeconds: "-1" }, "prompt");
    expect(post.mock.calls[0]![1]).toMatchObject({ resolution: "4k" });
    expect(post.mock.calls[0]![1]).not.toHaveProperty("duration");
    await expect(api.createVideoGenerationTask({ ...config, model: "video::doubao-seedance-2-5-260628", vquality: "4k" }, "prompt")).rejects.toThrow("分辨率");
});

test("Seedance 2.5 frames require adaptive ratio; reference generation uses its explicit task type", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "task" } }); mocks.push(post);
    const selected = { ...config, model: "video::doubao-seedance-2-5-260628", videoSize: "16:9" };
    const image = { id: "i", name: "image", type: "image/png", dataUrl: "data:image/png;base64,YQ==" };
    await expect(api.createVideoGenerationTask(selected, "prompt", [image])).rejects.toThrow("自动宽高比");
    expect(post).not.toHaveBeenCalled();
    await api.createVideoGenerationTask({ ...selected, videoMode: "reference" }, "prompt", [image]);
    expect(post.mock.calls[0]![1]).toMatchObject({ omni_reference_task_type: "reference", ratio: "16:9" });
});

test("Seedance applies per-model reference counts and prevents mixing frame and reference modes", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    const image = { id: "i", name: "image", type: "image/png", dataUrl: "data:image/png;base64,YQ==" };
    const video = { id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:video" };
    const selected = { ...config, model: "video::doubao-seedance-2-0-260128" };
    await expect(api.createVideoGenerationTask(selected, "prompt", Array(10).fill(image))).rejects.toThrow("9");
    await expect(api.createVideoGenerationTask(selected, "prompt", [image], { videos: [video] })).rejects.toThrow("不能混用");
    await expect(api.createVideoGenerationTask({ ...selected, videoMode: "reference" }, "prompt", [image], { videos: Array(4).fill(video) })).rejects.toThrow("3");
    expect(post).not.toHaveBeenCalled();
});

test("H3 sends explicit public parameters and every reference role without WAN switches", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "h3-task" } }); mocks.push(post);
    const selected = { ...config, model: "video::MiniMax-H3", videoSeconds: "4", vquality: "2K", videoSize: "21:9", videoMode: "reference", videoGenerateAudio: "true", videoWatermark: "true" };
    const image = { id: "i", name: "image", type: "image/png", dataUrl: "", storageKey: "image:h3" };
    const videos = [{ id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:h3-video" }];
    const audios = [{ id: "a", name: "audio", type: "audio/mp3", url: "", storageKey: "file:h3-audio" }];
    const task = await api.createVideoGenerationTask(selected, "镜头推进", [image], { videos, audios });
    expect(task).toEqual({ id: "h3-task", path: "videos", model: selected.model });
    expect(post.mock.calls[0]![0]).toEndWith("/v1/videos");
    expect(post.mock.calls[0]![1]).toEqual({ model: "MiniMax-H3", prompt: "镜头推进", duration: 4, resolution: "2K", ratio: "21:9", metadata: { input: { media: [
        { type: "reference_image", url: "/api/files/image_files/image%3Ah3" },
        { type: "reference_video", url: "/api/files/media_files/file%3Ah3-video" },
        { type: "reference_audio", url: "/api/files/media_files/file%3Ah3-audio" },
    ] } } });
    expect(signed).toHaveLength(0);
});

test("H3 rejects inherited parameters, excess references and frame mixing before uploading or creating", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    const selected = { ...config, model: "video::MiniMax-H3", vquality: "768", videoSeconds: "4", videoMode: "reference" };
    const image = { id: "i", name: "image", type: "image/png", dataUrl: "", storageKey: "image:h3" };
    const video = { id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:video" };
    for (const videoSeconds of ["-1", "3", "31"]) await expect(api.createVideoGenerationTask({ ...selected, videoSeconds }, "画面")).rejects.toThrow("4–30");
    await expect(api.createVideoGenerationTask({ ...selected, vquality: "720" }, "画面")).rejects.toThrow("分辨率");
    await expect(api.createVideoGenerationTask(selected, "画面", Array(10).fill(image))).rejects.toThrow("9");
    await expect(api.createVideoGenerationTask({ ...selected, videoMode: "frames" }, "画面", Array(3).fill(image))).rejects.toThrow("不能混用");
    await expect(api.createVideoGenerationTask({ ...selected, videoMode: "frames" }, "画面", [], { videos: [video] })).rejects.toThrow("参考模式");
    await expect(api.createVideoGenerationTask(selected, "画面", [], { videos: Array(4).fill(video) })).rejects.toThrow("3");
    expect(post).not.toHaveBeenCalled();
    expect(signed).toHaveLength(0);
});

test("H3 creation timeout is never reposted and saved tasks retain their protocol after model switching", async () => {
    const post = spyOn(axios, "post").mockRejectedValue(new Error("timeout")); mocks.push(post);
    const selected = { ...config, model: "video::MiniMax-H3", vquality: "768", videoSeconds: "4" };
    await expect(api.createVideoGenerationTask(selected, "画面")).rejects.toThrow("timeout");
    expect(post).toHaveBeenCalledTimes(1);
    const file = { url: "/api/files/media_files/h3-result", storageKey: "h3-result", bytes: 10, mimeType: "video/mp4" };
    const get = spyOn(axios, "get").mockResolvedValue({ data: { status: "completed", file } }); mocks.push(get);
    const task = { id: "h3-existing", path: "videos" as const, model: selected.model };
    expect(await api.waitForVideoGenerationTask({ ...config, model: "video::seedance" }, task)).toEqual(file);
    expect(get.mock.calls[0]![0]).toEndWith("/videos/h3-existing");
    expect(post).toHaveBeenCalledTimes(1);
});

test("configured protocol and preset independently determine endpoint and parameters for aliases", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "public-alias-task", status: "queued" } }); mocks.push(post);
    const selected: AiConfig = { ...config, model: "video::custom-alias", videoSize: "16:9", vquality: "1080", videoSeconds: "30", videoFastMode: "false", channels: [{ ...config.channels[0]!, models: [{ name: "custom-alias", capability: "video", videoType: "tokenone", videoPreset: "MiniMax-H3", videoProfile: defaultVideoParameterPresets["MiniMax-H3"]?.profile }] }] };
    await api.createVideoGenerationTask(selected, "画面");
    expect(post.mock.calls[0]![0]).toEndWith("/v1/videos");
    expect(post.mock.calls[0]![1]).toEqual({ model: "custom-alias", prompt: "画面", duration: 30, resolution: "1080P", ratio: "16:9", metadata: { parameters: { fast_mode: false } } });
    const sd: AiConfig = { ...selected, vquality: "720", channels: [{ ...config.channels[0]!, models: [{ name: "custom-alias", capability: "video", videoType: "tokenone", videoPreset: "sd-2.5-ch1", videoProfile: defaultVideoParameterPresets["sd-2.5-ch1"]?.profile }] }] };
    await expect(api.createVideoGenerationTask({ ...sd, videoSeconds: "-1" }, "画面")).rejects.toThrow("4–30");
    expect(post).toHaveBeenCalledTimes(1);
    await api.createVideoGenerationTask(sd, "画面");
    expect(post.mock.calls[1]![1]).toEqual({ model: "custom-alias", prompt: "画面", duration: 30, resolution: "720P", ratio: "16:9" });
});
