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
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://creative.test" } } });
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/auth/me") return Response.json({ user: { id: "alice" }, csrf: "csrf" });
        if (path === "/api/channels") return Response.json({ channels: [] });
        if (path === "/api/model-authorization") return Response.json(null);
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
    config = { ...defaultConfig, model: "video::wan3.0-video-720p", size: "4:3", videoSize: "auto", channels: [{
        id: "video", name: "Video", baseUrl: "https://creative.test/api/ai/video/v1", apiKey: "csrf", apiFormat: "openai",
        models: [
            { name: "wan3.0-video-720p", capability: "video", videoType: "wan" },
            { name: "wan3.0-image-1080p", capability: "video", videoType: "wan" },
            { name: "seedance", capability: "video", videoType: "seedance" },
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
    const post = spyOn(axios, "post").mockResolvedValue({ data: { code: 0, data: { task_id: "wan-task" } } }); mocks.push(post);
    const task = await api.createVideoGenerationTask(config, "镜头向前", [{ id: "i", name: "image", type: "image/png", dataUrl: "", storageKey: "image:one" }], {
        videos: [{ id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:video" }],
        audios: [{ id: "a", name: "audio", type: "audio/mp3", url: "", storageKey: "file:audio" }],
    });
    expect(task).toEqual({ id: "wan-task", provider: "wan", model: config.model });
    expect(post.mock.calls[0]![0]).toEndWith("/v1/videos");
    expect(post.mock.calls[0]![1]).toEqual({ model: "wan3.0-video-720p", prompt: "镜头向前", seconds: "6", aspect_ratio: "adaptive",
        reference_images: [{ url: "/api/files/image_files/image%3Aone", role: "first_frame" }],
        reference_videos: [{ url: "/api/files/media_files/file%3Avideo" }], reference_audios: [{ url: "/api/files/media_files/file%3Aaudio" }],
    });
    expect(signed).toHaveLength(0);
    expect(settings.videoSettingsForModel({ ...config, vquality: "1080" }, config.model)).toMatchObject({ ratio: "auto", resolution: "720" });
});

test("image-only WAN rejects missing images and reference videos before creating or signing", async () => {
    const post = spyOn(axios, "post"); mocks.push(post);
    const imageConfig = { ...config, model: "video::wan3.0-image-1080p" };
    await expect(api.createVideoGenerationTask(imageConfig, "prompt")).rejects.toThrow("至少一张");
    await expect(api.createVideoGenerationTask(imageConfig, "prompt", [], { videos: [{ id: "v", name: "video", type: "video/mp4", url: "", storageKey: "file:video" }] })).rejects.toThrow("不支持参考视频");
    expect(post).not.toHaveBeenCalled();
    expect(signed).toHaveLength(0);
});

test("Seedance retains its endpoint, numeric duration, ratio and audio switches", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "seedance-task" } }); mocks.push(post);
    expect(await api.createVideoGenerationTask({ ...config, model: "video::seedance", videoSize: "4:3" }, "prompt")).toMatchObject({ provider: "seedance" });
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
    await expect(api.createVideoGenerationTask({ ...config, videoSize: "4:3" }, "prompt")).rejects.toThrow("宽高比");
    expect(post).not.toHaveBeenCalled();
});

test("resuming WAN reads server file metadata without downloading or uploading the video", async () => {
    const file = { url: "/api/files/media_files/file:completed", storageKey: "file:completed", bytes: 4915678, mimeType: "video/mp4", width: 960, height: 960, durationMs: 4000 };
    const get = spyOn(axios, "get").mockResolvedValue({ data: { code: 0, data: { id: "wan-task", status: "completed", file } } }); mocks.push(get);
    expect(await api.waitForVideoGenerationTask({ ...config, model: "video::seedance" }, { id: "wan-task", provider: "wan", model: config.model })).toEqual(file);
    expect(get.mock.calls[0]![0]).toEndWith("/v1/videos/wan-task");
    expect(get).toHaveBeenCalledTimes(1);
    // No document/media element exists, and the fetch mock rejects all media uploads.
});

test("a completed response without a stored file never falls back to client download or upload", async () => {
    const get = spyOn(axios, "get").mockResolvedValue({ data: { status: "completed", metadata: { url: "https://upstream.test/video.mp4" } } }); mocks.push(get);
    await expect(api.pollVideoGenerationTask(config, { id: "wan-task", provider: "wan", model: config.model })).rejects.toThrow("服务端尚未返回");
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
    const waiting = api.waitForVideoGenerationTask(config, { id: "wan-task", provider: "wan", model: config.model });
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
    for (const provider of ["wan", "seedance"] as const) {
        get.mockResolvedValueOnce({ data: { status: "queued" } }).mockResolvedValueOnce({ data: { status: provider === "wan" ? "completed" : "succeeded", file } });
        expect(await api.waitForVideoGenerationTask(config, { id: "existing", provider, model: config.model })).toEqual(file);
    }
    expect(get).toHaveBeenCalledTimes(4);
});

test("paused tasks require explicit resume and never resubmit generation", async () => {
    const get = spyOn(axios, "get").mockResolvedValue({ data: { status: "paused", error: { message: "后台下载暂时失败" } } }); mocks.push(get);
    const post = spyOn(axios, "post").mockResolvedValue({ data: { status: "queued" } }); mocks.push(post);
    const task = { id: "existing", provider: "wan" as const, model: config.model };
    await expect(api.waitForVideoGenerationTask(config, task)).rejects.toThrow("后台下载暂时失败");
    expect(post).not.toHaveBeenCalled();
    await api.resumeVideoGenerationTask(config, task);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toEndWith("/videos/existing/resume");
});
