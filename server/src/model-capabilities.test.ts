import { test } from "node:test";
import assert from "node:assert/strict";
import { imageRequestCapabilityError, videoRequestCapabilityError } from "./model-capabilities.js";

const seed20 = "doubao-seedance-2-0-260128", seed25 = "doubao-seedance-2-5-260628";
const images = (count: number, role = "reference_image") => Array.from({ length: count }, () => ({ type: "image_url", role, image_url: { url: "https://example.com/a.png" } }));
test("image server guard validates quality, pixel dimensions and both JSON/multipart references", () => {
    assert.equal(imageRequestCapabilityError("gpt-image-2.5-flare", "openai", { quality: "max", size: "3840x2160" }), "");
    assert.match(imageRequestCapabilityError("gpt-image-2", "openai", { quality: "max" }), /画质/);
    assert.match(imageRequestCapabilityError("gpt-image-2", "openai", { size: "1025x1024" }), /16/);
    assert.match(imageRequestCapabilityError("gpt-image-2", "openai", { image_references: Array(17).fill("url") }), /16 张/);
    assert.match(imageRequestCapabilityError("gpt-image-2", "openai", {}, 17), /16 张/);
    assert.equal(imageRequestCapabilityError("banana2-1k", "banana", { images: Array(17).fill("url") }), "");
});
test("Grok guard checks single-image aspect ratio and model-specific edit limits", () => {
    assert.match(imageRequestCapabilityError("grok-imagine-image", "grok", { image: {}, aspect_ratio: "16:9" }), /省略/);
    assert.match(imageRequestCapabilityError("grok-imagine-image", "grok", { images: [{}, {}] }), /1 张/);
    assert.equal(imageRequestCapabilityError("grok-imagine-image-2.0", "grok", { images: Array(5).fill({}), quality: "medium", aspect_ratio: "19.5:9", resolution: "2k" }), "");
});
test("Seedance server guard applies model limits and preserves auto/4k protocol values", () => {
    assert.match(videoRequestCapabilityError(seed20, "seedance", { duration: 30 }), /4–15/);
    assert.equal(videoRequestCapabilityError(seed20, "seedance", { duration: -1, resolution: "4k", content: images(9) }), "");
    assert.match(videoRequestCapabilityError(seed20, "seedance", { content: images(10) }), /9/);
    assert.equal(videoRequestCapabilityError(seed25, "seedance", { duration: 30, content: images(30) }), "");
    assert.match(videoRequestCapabilityError(seed25, "seedance", { resolution: "4k" }), /分辨率/);
});
test("Seedance frame roles cannot bypass scene rules", () => {
    assert.match(videoRequestCapabilityError(seed25, "seedance", { ratio: "16:9", content: images(1, "first_frame") }), /自动宽高比/);
    assert.match(videoRequestCapabilityError(seed20, "seedance", { content: images(2, "first_frame") }), /首尾帧/);
    assert.match(videoRequestCapabilityError(seed20, "seedance", { content: [...images(1, "first_frame"), { type: "audio_url", role: "reference_audio" }] }), /不能混用/);
    assert.match(videoRequestCapabilityError(seed20, "seedance", { content: [{ type: "audio_url", role: "reference_audio" }] }), /搭配/);
    assert.equal(videoRequestCapabilityError(seed25, "seedance", { content: [{ type: "audio_url", role: "reference_audio" }] }), "");
});
test("WAN public models validate duration, resolution and media combinations", () => {
    const request = { model: "wan3.0-video", prompt: "  镜头前移  ", duration: 2, resolution: "480P", ratio: "adaptive" };
    const media = (types: string[]) => ({ input: { media: types.map((type) => ({ type, url: "https://example.com/ref" })) } });
    for (const model of ["wan3.0-video", "wan3.0-video-prime"]) {
        for (const ratio of ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"]) assert.equal(videoRequestCapabilityError(model, "wan", { ...request, model, ratio }), "");
        for (const duration of [2, 30]) assert.equal(videoRequestCapabilityError(model, "wan", { ...request, model, duration }), "");
        for (const duration of [-1, 1, 31]) assert.match(videoRequestCapabilityError(model, "wan", { ...request, model, duration }), /2–30/);
    }
    for (const resolution of ["480P", "720P", "1080P"]) assert.equal(videoRequestCapabilityError(request.model, "wan", { ...request, resolution }), "");
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, resolution: "4K" }), /公共格式/);
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, ratio: "21:9" }), /公共格式/);
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, seconds: "2" }), /公共格式/);
    assert.match(videoRequestCapabilityError("wan3.0-video-720p", "wan", request), /公共模型/);
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, metadata: media(["last_frame"]) }), /首尾帧/);
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, metadata: media(["first_frame", "reference_video"]) }), /不能混用/);
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, metadata: media(["first_frame", "reference_image"]) }), /首尾帧/);
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, metadata: media(Array(11).fill("reference_image")) }), /10/);
    assert.equal(videoRequestCapabilityError(request.model, "wan", { ...request, metadata: media(["first_frame", "last_frame"]) }), "");
    assert.equal(videoRequestCapabilityError(request.model, "wan", { ...request, metadata: media(["reference_image", "reference_video", "reference_audio"]) }), "");
});

test("canvas and workbench construct the same WAN public request and preserve reference order", async () => {
    const { videoRequestBody } = await import("../../shared/video-request.js");
    const { canvasRequestBody } = await import("../../shared/canvas-request.js");
    const references = { images: ["https://example.com/one", "https://example.com/one"], videos: ["https://example.com/video"], audios: ["https://example.com/audio"] };
    const params = { seconds: "6", ratio: "auto", resolution: "720", mode: "reference", generateAudio: false, watermark: false };
    const direct = videoRequestBody("wan3.0-video", "wan", "  镜头前移  ", references, params);
    const canvas = canvasRequestBody("wan3.0-video", "video", "wan", { prompt: "  镜头前移  ", seconds: "6", videoSize: "auto", vquality: "720", videoMode: "reference" }, references);
    assert.deepEqual(direct, canvas);
    assert.deepEqual(direct, { model: "wan3.0-video", prompt: "  镜头前移  ", duration: 6, resolution: "720P", ratio: "adaptive", metadata: { input: { media: [
        { type: "reference_image", url: references.images[0] }, { type: "reference_image", url: references.images[1] },
        { type: "reference_video", url: references.videos[0] }, { type: "reference_audio", url: references.audios[0] },
    ] } } });
    assert.equal(videoRequestCapabilityError("wan3.0-video", "wan", direct), "");
});

test("H3 public requests preserve both resolutions, all ratios and duration boundaries", async () => {
    const { videoRequestBody } = await import("../../shared/video-request.js");
    const { canvasRequestBody } = await import("../../shared/canvas-request.js");
    const references = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
    for (const resolution of ["768", "2k"]) for (const ratio of ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"]) for (const seconds of ["4", "15"]) {
        const body = videoRequestBody("MiniMax-H3", "h3", "画面", references, { resolution, ratio, seconds, mode: "reference", generateAudio: true, watermark: true });
        assert.equal(videoRequestCapabilityError("MiniMax-H3", "h3", body), "");
        assert.deepEqual(body, { model: "MiniMax-H3", prompt: "画面", duration: Number(seconds), resolution: resolution === "2k" ? "2K" : "768P", ratio: ratio === "auto" ? "adaptive" : ratio, generation_mode: "frames" });
        assert.deepEqual(canvasRequestBody("MiniMax-H3", "video", "h3", { prompt: "画面", seconds, vquality: resolution, videoSize: ratio, videoMode: "reference" }, references), body);
    }
});

test("H3 enforces its whitelist and explicit material roles without silently changing frame mode", async () => {
    const { videoRequestBody } = await import("../../shared/video-request.js");
    const { canvasRequestBody } = await import("../../shared/canvas-request.js");
    const body = { model: "MiniMax-H3", prompt: "画面", duration: 4, resolution: "768P", ratio: "16:9", generation_mode: "frames" };
    const withMedia = (types: string[], mode = "references") => ({ ...body, generation_mode: mode, metadata: { input: { media: types.map((type) => ({ type, url: "https://example.com/file" })) } } });
    for (const duration of [-1, 3, 16, 4.5]) assert.match(videoRequestCapabilityError(body.model, "h3", { ...body, duration }), /4–15|公共格式/);
    for (const field of ["audio", "seed", "watermark", "prompt_extend", "auto_duration", "content", "seconds", "image_urls"]) assert.match(videoRequestCapabilityError(body.model, "h3", { ...body, [field]: [] }), /公共格式/);
    assert.match(videoRequestCapabilityError(body.model, "h3", { ...body, resolution: "720P" }), /公共格式/);
    assert.match(videoRequestCapabilityError(body.model, "h3", { ...body, generation_mode: undefined }), /公共格式/);
    for (const types of [["first_frame"], ["first_frame", "last_frame"]]) assert.equal(videoRequestCapabilityError(body.model, "h3", withMedia(types, "frames")), "");
    for (const count of [5, 6, 9]) assert.equal(videoRequestCapabilityError(body.model, "h3", withMedia(Array(count).fill("reference_image"))), "");
    assert.match(videoRequestCapabilityError(body.model, "h3", withMedia(Array(10).fill("reference_image"))), /9/);
    assert.match(videoRequestCapabilityError(body.model, "h3", withMedia(["last_frame"], "frames")), /首尾帧/);
    assert.match(videoRequestCapabilityError(body.model, "h3", withMedia(["first_frame", "reference_image"])), /首尾帧/);
    assert.match(videoRequestCapabilityError(body.model, "h3", withMedia(["reference_image"], "frames")), /模式/);
    assert.match(videoRequestCapabilityError(body.model, "h3", withMedia(["first_frame"], "references")), /模式/);
    const references = { images: Array(3).fill("https://example.com/image"), videos: [], audios: [] };
    const canvas = canvasRequestBody(body.model, "video", "h3", { prompt: "画面", seconds: "4", vquality: "768", videoSize: "16:9", videoMode: "frames" }, references);
    assert.equal(canvas.generation_mode, "frames");
    assert.match(videoRequestCapabilityError(body.model, "h3", canvas), /首尾帧/);
    const params = { seconds: "4", resolution: "2k", ratio: "auto", mode: "reference", generateAudio: false, watermark: false };
    const mixed = videoRequestBody(body.model, "h3", "画面", { images: references.images, videos: ["https://example.com/v"], audios: ["https://example.com/a"] }, params);
    assert.equal(videoRequestCapabilityError(body.model, "h3", mixed), "");
    assert.equal(mixed.generation_mode, "references");
    for (const role of ["reference_video", "reference_audio"]) {
        assert.equal(videoRequestCapabilityError(body.model, "h3", withMedia(Array(3).fill(role))), "");
        assert.match(videoRequestCapabilityError(body.model, "h3", withMedia(Array(4).fill(role))), /3/);
        assert.match(videoRequestCapabilityError(body.model, "h3", withMedia([role], "frames")), /模式/);
    }
});
