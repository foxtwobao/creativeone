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
        for (const duration of [2, 30]) assert.equal(videoRequestCapabilityError(model, "wan", { ...request, model, duration }), "");
        for (const duration of [-1, 1, 31]) assert.match(videoRequestCapabilityError(model, "wan", { ...request, model, duration }), /2–30/);
    }
    for (const resolution of ["480P", "720P", "1080P"]) assert.equal(videoRequestCapabilityError(request.model, "wan", { ...request, resolution }), "");
    assert.match(videoRequestCapabilityError(request.model, "wan", { ...request, resolution: "4K" }), /公共格式/);
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
