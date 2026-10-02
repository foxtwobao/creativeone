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
    assert.equal(imageRequestCapabilityError("banana2-1k", "banana", { image_urls: Array(17).fill("url") }), "");
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
test("WAN fixed resolution and media restrictions remain independent of undocumented duration bounds", () => {
    assert.equal(videoRequestCapabilityError("wan3.0-video-prime-720p", "wan", { seconds: "30", aspect_ratio: "adaptive" }), "");
    assert.match(videoRequestCapabilityError("wan3.0-image-720p", "wan", { seconds: "6" }), /至少一张/);
    assert.match(videoRequestCapabilityError("wan3.0-image-720p", "wan", { seconds: "6", reference_images: [{}], reference_videos: [{}] }), /不支持参考视频/);
    assert.match(videoRequestCapabilityError("wan3.0-video-720p", "wan", { seconds: "6", reference_images: Array(11).fill({}) }), /10/);
    assert.match(videoRequestCapabilityError("my-wan-720p", "wan", { seconds: "6" }), /尚未配置/);
});
