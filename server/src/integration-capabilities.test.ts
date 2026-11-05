import { test } from "node:test";
import assert from "node:assert/strict";
import { imageModelProfile, imagePixelSizeError } from "../../shared/image-models.js";
import { videoModelProfile, videoCapabilityError } from "../../shared/video-models.js";
import { imageIntegrationCapabilities, videoIntegrationCapabilities, musicIntegrationCapabilities } from "./integration-capabilities.js";

const refs = { images: 0, videos: 0, audios: 0 };
test("image capability options and pixel combinations follow the configured profile", () => {
    const profile = imageModelProfile("gpt-image-2", "openai");
    profile.pixelBounds.maxPixels = 4_194_304;
    const result = imageIntegrationCapabilities({ callType: "openai", preset: "test", profile });
    assert.deepEqual(result.parameters.properties?.quality.enum, profile.qualities);
    assert.deepEqual(result.parameters.properties?.background.enum, ["", "transparent"]);
    assert.deepEqual(result.constraints.pixelBounds, profile.pixelBounds);
    assert.equal(imagePixelSizeError("2048x2048", result.constraints.pixelBounds), "");
    assert.ok(imagePixelSizeError("3840x2160", result.constraints.pixelBounds));
    assert.equal(result.parameters.properties?.resolution, undefined, "pixel resolutions are expressed through size mappings, not an ignored field");
    const banana = imageIntegrationCapabilities({ callType: "banana", preset: "fixed", profile: imageModelProfile("banana2-2k", "banana") });
    assert.equal(banana.constraints.fixedResolution, "2k");
    assert.equal(banana.parameters.properties?.background, undefined);
    assert.equal(banana.parameters.properties?.quality, undefined);
});

test("video conditional duration constraints match the actual H3 validation", () => {
    const profile = videoModelProfile("MiniMax-H3", "h3");
    const result = videoIntegrationCapabilities({ callType: "tokenone", preset: "test", profile });
    assert.deepEqual(result.parameters.properties?.resolution.enum, ["480P", "768P", "1080P", "2K"]);
    assert.deepEqual(result.constraints.durationByResolution?.["2K"], profile.durationByResolution?.["2k"]);
    const branches = (result.parameters as any).allOf;
    assert.equal(branches.find((rule: any) => rule.if.properties.resolution.const === "2K").then.properties.seconds.maximum, 15);
    assert.equal(branches.find((rule: any) => rule.if.properties.resolution.const === "1080P").then.properties.seconds.maximum, 30);
    assert.equal(videoCapabilityError(profile, { resolution: "2k", ratio: "16:9", mode: "frames", seconds: 15 }, refs), "");
    assert.ok(videoCapabilityError(profile, { resolution: "2k", ratio: "16:9", mode: "frames", seconds: 16 }, refs));
    assert.deepEqual(result.parameters.properties?.fastMode.enum, [false, true]);
    assert.equal(result.parameters.properties?.generateAudio, undefined);
    assert.equal(result.parameters.properties?.watermark, undefined);
});

test("video fixed duration, auto duration and reference combinations are retained", () => {
    const veoProfile = videoModelProfile("veo-3.1-fast", "veo");
    const veo = videoIntegrationCapabilities({ callType: "tokenone", preset: "test", profile: veoProfile });
    assert.equal(veo.parameters.properties?.seconds, undefined);
    assert.deepEqual(veo.parameters.properties?.mode.enum, veoProfile.modes);
    assert.equal(veo.constraints.defaultMode, veoProfile.defaults.mode);
    assert.deepEqual(veo.constraints.referenceImages, { min: 3, max: 3 });
    assert.equal(veo.constraints.frames.lastRequiresFirst, true);
    assert.equal(veo.constraints.frames.mixedReferences, false);
    const seedanceProfile = videoModelProfile("doubao-seedance-2-5-260628", "seedance");
    const seedance = videoIntegrationCapabilities({ callType: "seedance", preset: "test", profile: seedanceProfile });
    assert.ok((seedance.parameters.properties?.seconds as any).anyOf.some((rule: any) => rule.const === -1));
    assert.equal(seedance.parameters.properties?.generateAudio.type, "boolean");
    assert.equal(seedance.constraints.frames.adaptiveRatio, seedanceProfile.framesAdaptive);
    assert.equal(seedance.constraints.referenceSeconds, seedanceProfile.referenceSeconds);
});

test("public capability metadata does not disclose protocol identity and uses existing seed bounds", () => {
    const result = videoIntegrationCapabilities({ callType: "tokenone", preset: "private-preset", profile: videoModelProfile("wan3-standard", "wan") });
    assert.equal(result.parameters.properties?.seed.minimum, -1);
    assert.equal(result.parameters.properties?.seed.maximum, 2147483647);
    assert.equal(result.parameters.properties?.generateAudio, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-preset|"family"|"callType"|"provider"|"path"|"group"/);
});

test("music directory exposes both supported modes", () => {
    assert.deepEqual(musicIntegrationCapabilities().parameters.properties?.mode.enum, ["song", "instrumental"]);
});
