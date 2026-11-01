import { test } from "node:test";
import assert from "node:assert/strict";
import { imageRequestCapabilityError, videoRequestCapabilityError } from "./model-capabilities.js";
import { veoModels, videoModelProfile, veoPromptError } from "../../shared/video-models.js";
import { videoRequestBody } from "../../shared/video-request.js";
import { canvasRequestBody } from "../../shared/canvas-request.js";

const seed20 = "doubao-seedance-2-0-260128", seed25 = "doubao-seedance-2-5-260628";
const images = (count: number, role = "reference_image") => Array.from({ length: count }, () => ({ type: "image_url", role, image_url: { url: "https://example.com/a.png" } }));

test("public video validation rejects aliases, unknown fields and invalid role combinations", () => {
    const body = { model: "veo-3.1", prompt: "画面", resolution: "720P", ratio: "16:9" };
    assert.equal(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: body.model }, body), "");
    for (const extra of [{ duration: 8 }, { size: "1280x720" }, { generation_mode: "text" }, { metadata: { parameters: { unexpected: true } } }]) assert.ok(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: body.model }, { ...body, ...extra }));
    for (const types of [["last_frame"], ["first_frame", "first_frame"], ["first_frame", "reference_image"], ["reference_video"]]) {
        assert.ok(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: body.model }, { ...body, metadata: { input: { media: types.map(type => ({ type, url: "https://example.com/a" })) } } }));
    }
    assert.equal(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: body.model }, { ...body, metadata: { input: { media: ["last_frame", "first_frame"].map(type => ({ type, url: "https://example.com/a" })) } } }), "");
});

test("Veo / Omni workbench and canvas share strict requests and never drop unsupported media silently", () => {
    for (const model of veoModels) for (const ratio of ["16:9", "9:16"]) {
        const profile = videoModelProfile(model, "veo");
        for (let count = 0; count <= (profile.maxImages || 0); count++) {
            const mode = model === "omni-flash-video" || count === 3 ? "reference" : "frames";
            const refs = { images: Array.from({ length: count }, (_, index) => `/api/files/image_files/image%3A${index}`), videos: [], audios: [] };
            const params = { seconds: "99", resolution: profile.resolutions[0], ratio, mode, generateAudio: true, watermark: true };
            const direct = videoRequestBody(model, { callType: "tokenone", preset: model }, "画面", refs, params);
            assert.deepEqual(canvasRequestBody(model, "video", "veo", { prompt: "画面", seconds: params.seconds, vquality: params.resolution, videoSize: ratio, videoMode: mode }, refs, "", "", { callType: "tokenone", preset: model }), direct);
            assert.equal(videoRequestCapabilityError(model, { callType: "tokenone", preset: model }, direct), "");
            assert.deepEqual(Object.keys(direct).sort(), ["model", "prompt", "resolution", "ratio", ...(count ? ["metadata"] : [])].sort());
            if (count) assert.deepEqual(direct.metadata?.input?.media.map(item => item.url), refs.images);
        }
        assert.equal(videoRequestCapabilityError(model, { callType: "tokenone", preset: model }, canvasRequestBody(model, "video", "veo", { prompt: "画面" }, { images: [], videos: [], audios: [] }, "", "", { callType: "tokenone", preset: model })), "");
        for (const kind of ["videos", "audios"]) assert.throws(() => canvasRequestBody(model, "video", "veo", { prompt: "画面" }, { images: [], videos: [], audios: [], [kind]: ["https://example.com/ref"] }, "", "", { callType: "tokenone", preset: model }));
    }
});

test("Veo / Omni prompts validate both Unicode character count and UTF-8 byte count", () => {
    assert.equal(veoPromptError("a".repeat(10_000)), "");
    assert.ok(veoPromptError("a".repeat(10_001)));
    assert.equal(veoPromptError("中".repeat(5461)), "");
    assert.ok(veoPromptError("中".repeat(5462)));
    assert.ok(veoPromptError("   "));
});
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
    assert.match(videoRequestCapabilityError(seed20, { callType: "seedance", preset: seed20 }, { duration: 30 }), /4–15/);
    assert.equal(videoRequestCapabilityError(seed20, { callType: "seedance", preset: seed20 }, { duration: -1, resolution: "4k", content: images(9) }), "");
    assert.match(videoRequestCapabilityError(seed20, { callType: "seedance", preset: seed20 }, { content: images(10) }), /9/);
    assert.equal(videoRequestCapabilityError(seed25, { callType: "seedance", preset: seed25 }, { duration: 30, content: images(30) }), "");
    assert.match(videoRequestCapabilityError(seed25, { callType: "seedance", preset: seed25 }, { resolution: "4k" }), /分辨率/);
});
test("Seedance frame roles cannot bypass scene rules", () => {
    assert.match(videoRequestCapabilityError(seed25, { callType: "seedance", preset: seed25 }, { ratio: "16:9", content: images(1, "first_frame") }), /自动宽高比/);
    assert.match(videoRequestCapabilityError(seed20, { callType: "seedance", preset: seed20 }, { content: images(2, "first_frame") }), /首尾帧/);
    assert.match(videoRequestCapabilityError(seed20, { callType: "seedance", preset: seed20 }, { content: [...images(1, "first_frame"), { type: "audio_url", role: "reference_audio" }] }), /不能混用/);
    assert.match(videoRequestCapabilityError(seed20, { callType: "seedance", preset: seed20 }, { content: [{ type: "audio_url", role: "reference_audio" }] }), /搭配/);
    assert.equal(videoRequestCapabilityError(seed25, { callType: "seedance", preset: seed25 }, { content: [{ type: "audio_url", role: "reference_audio" }] }), "");
});
test("WAN public models validate duration, resolution and media combinations", () => {
    const request = { model: "wan3.0-video", prompt: "  镜头前移  ", duration: 2, resolution: "480P", ratio: "adaptive" };
    const media = (types: string[]) => ({ input: { media: types.map((type) => ({ type, url: "https://example.com/ref" })) } });
    for (const model of ["wan3.0-video", "wan3.0-video-prime"]) {
        for (const ratio of ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"]) assert.equal(videoRequestCapabilityError(model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, model, ratio }), "");
        for (const duration of [2, 30]) assert.equal(videoRequestCapabilityError(model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, model, duration }), "");
        for (const duration of [-1, 1, 31]) assert.match(videoRequestCapabilityError(model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, model, duration }), /2–30|公共格式/);
    }
    for (const resolution of ["480P", "720P", "1080P"]) assert.equal(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, resolution }), "");
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, resolution: "4K" }), /公共格式/);
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, ratio: "21:9" }), /宽高比/);
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, seconds: "2" }), /公共格式/);
    assert.match(videoRequestCapabilityError("wan3.0-video-720p", { callType: "tokenone", preset: "wan3.0-video" }, request), /模型/);
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, metadata: media(["last_frame"]) }), /首尾帧/);
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, metadata: media(["first_frame", "reference_video"]) }), /不能混用/);
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, metadata: media(["first_frame", "reference_image"]) }), /首尾帧/);
    assert.match(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, metadata: media(Array(11).fill("reference_image")) }), /10/);
    assert.equal(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, metadata: media(["first_frame", "last_frame"]) }), "");
    assert.equal(videoRequestCapabilityError(request.model, { callType: "tokenone", preset: "wan3.0-video" }, { ...request, metadata: media(["reference_image", "reference_video", "reference_audio"]) }), "");
});

test("canvas and workbench construct the same WAN public request and preserve reference order", async () => {
    const { videoRequestBody } = await import("../../shared/video-request.js");
    const { canvasRequestBody } = await import("../../shared/canvas-request.js");
    const references = { images: ["https://example.com/one", "https://example.com/one"], videos: ["https://example.com/video"], audios: ["https://example.com/audio"] };
    const params = { seconds: "6", ratio: "auto", resolution: "720", mode: "reference", generateAudio: false, watermark: false };
    const direct = videoRequestBody("wan3.0-video", { callType: "tokenone", preset: "wan3.0-video" }, "  镜头前移  ", references, params);
    const canvas = canvasRequestBody("wan3.0-video", "video", "wan", { prompt: "  镜头前移  ", seconds: "6", videoSize: "auto", vquality: "720", videoMode: "reference" }, references, "", "", { callType: "tokenone", preset: "wan3.0-video" });
    assert.deepEqual(direct, canvas);
    assert.deepEqual(direct, { model: "wan3.0-video", prompt: "  镜头前移  ", duration: 6, resolution: "720P", ratio: "adaptive", metadata: { input: { media: [
        { type: "reference_image", url: references.images[0] }, { type: "reference_image", url: references.images[1] },
        { type: "reference_video", url: references.videos[0] }, { type: "reference_audio", url: references.audios[0] },
    ] } } });
    assert.equal(videoRequestCapabilityError("wan3.0-video", { callType: "tokenone", preset: "wan3.0-video" }, direct), "");
});

test("H3 public requests preserve both resolutions, all ratios and duration boundaries", async () => {
    const { videoRequestBody } = await import("../../shared/video-request.js");
    const { canvasRequestBody } = await import("../../shared/canvas-request.js");
    const references = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
    for (const resolution of ["768", "2k"]) for (const ratio of ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"]) for (const seconds of ["4", "15"]) {
        const body = videoRequestBody("MiniMax-H3", { callType: "tokenone", preset: "MiniMax-H3" }, "画面", references, { resolution, ratio, seconds, mode: "reference", generateAudio: true, watermark: true });
        assert.equal(videoRequestCapabilityError("MiniMax-H3", { callType: "tokenone", preset: "MiniMax-H3" }, body), "");
        assert.deepEqual(body, { model: "MiniMax-H3", prompt: "画面", duration: Number(seconds), resolution: resolution === "2k" ? "2K" : "768P", ratio: ratio === "auto" ? "adaptive" : ratio });
        assert.deepEqual(canvasRequestBody("MiniMax-H3", "video", "h3", { prompt: "画面", seconds, vquality: resolution, videoSize: ratio, videoMode: "reference" }, references, "", "", { callType: "tokenone", preset: "MiniMax-H3" }), body);
    }
});

test("H3 uses public media roles, 30-second limits and optional fast_mode without input", () => {
    const body = { model: "MiniMax-H3", prompt: "画面", duration: 30, resolution: "768P", ratio: "16:9" };
    for (const fast_mode of [false, true]) assert.equal(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, { ...body, metadata: { parameters: { fast_mode } } }), "");
    for (const resolution of ["480P", "768P", "1080P"]) assert.equal(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, { ...body, resolution }), "");
    assert.ok(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, { ...body, resolution: "2K" }));
    for (const duration of [0, -1, 3, 31, 4.5, null, "4"]) assert.ok(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, { ...body, duration }));
    for (const extra of [{ generation_mode: "frames" }, { metadata: { parameters: { audio: false } } }]) assert.ok(videoRequestCapabilityError(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, { ...body, ...extra }));
    const refs = { images: [], videos: [], audios: [] };
    assert.deepEqual(videoRequestBody(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, "画面", refs, { seconds: "30", resolution: "768", ratio: "16:9", mode: "frames", fastMode: false }), { ...body, metadata: { parameters: { fast_mode: false } } });
    for (const seconds of ["", " ", "0", "-1", "4.5"]) assert.throws(() => videoRequestBody(body.model, { callType: "tokenone", preset: "MiniMax-H3" }, "画面", refs, { seconds, resolution: "768", ratio: "16:9", mode: "frames" }));
    const wan = { ...body, model: "wan3.0-video", resolution: "720P", metadata: { parameters: { seed: 0, audio: false, watermark: false } } };
    assert.equal(videoRequestCapabilityError(wan.model, { callType: "tokenone", preset: "wan3.0-video" }, wan), "");
});

test("explicit presets control parameters without rewriting or guessing the model ID", async () => {
    const { videoConfiguredProfile } = await import("../../shared/video-models.js");
    const { videoTaskPath } = await import("../../shared/video-tasks.js");
    const config = { callType: "tokenone" as const, preset: "MiniMax-H3" };
    const refs = { images: [], videos: [], audios: [] };
    const body = videoRequestBody("custom-video-alias", config, "画面", refs, { seconds: "30", resolution: "1080", ratio: "16:9", mode: "frames", fastMode: false });
    assert.equal(body.model, "custom-video-alias");
    assert.equal(videoRequestCapabilityError(body.model, config, body), "");
    assert.equal(videoTaskPath(config.callType), "videos");
    assert.equal(videoTaskPath("seedance"), "contents/generations/tasks");
    assert.throws(() => videoConfiguredProfile({ callType: "seedance", preset: "MiniMax-H3" }));
    assert.throws(() => videoConfiguredProfile({ callType: "tokenone", preset: "unknown" }));
    const sd = { callType: "tokenone" as const, preset: "sd-2.5-ch1" };
    for (const seconds of ["", "-1", "0"]) assert.throws(() => videoRequestBody("sd-alias", sd, "画面", refs, { seconds, resolution: "720", ratio: "16:9", mode: "frames" }));
    assert.throws(() => videoRequestBody("sd-alias", sd, "画面", { ...refs, images: ["https://example.com/a"] }, { seconds: "6", resolution: "720", ratio: "16:9", mode: "frames" }));
    const pair = videoRequestBody("sd-alias", sd, "画面", { ...refs, images: ["https://example.com/a", "https://example.com/b"] }, { seconds: "6", resolution: "720", ratio: "3:2", mode: "frames" });
    assert.equal(videoRequestCapabilityError("sd-alias", sd, pair), "");
    assert.equal("content" in pair, false);
});

test("native requests reject public and removed aliases", () => {
    const config = { callType: "seedance" as const, preset: seed20 };
    const body = { model: seed20, content: [{ type: "text", text: "画面" }], duration: 5, resolution: "720p", ratio: "16:9", generate_audio: false, watermark: false };
    assert.equal(videoRequestCapabilityError(seed20, config, body), "");
    for (const extra of [{ seconds: 5 }, { aspect_ratio: "16:9" }, { generation_mode: "frames" }, { reference_images: [] }, { metadata: {} }]) {
        assert.ok(videoRequestCapabilityError(seed20, config, { ...body, ...extra }));
    }
    assert.throws(() => videoRequestCapabilityError(seed20, undefined!, body));
});
