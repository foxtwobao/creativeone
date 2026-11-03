import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultImageParameterPresets, imageModelOverrides, imageModelTypes, imageTypePresets, type ImageProfile } from "../../shared/image-models.js";
import { openAiImageParams, resolveRequestSize } from "../../shared/image-openai.js";
import { grokImageBody } from "../../shared/image-grok.js";
import { imageRatioOf, imageSizeFor } from "../../shared/image-size.js";
import { imageRequestCapabilityError } from "./model-capabilities.js";

Object.assign(process.env, { DATABASE_URL: "postgresql://unused/unused", APP_ORIGIN: "https://creative.test", IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "test", ENHANCER_BASE_URL: "https://reseller.test" });
const { imageProfileSchema } = await import("./image-presets.js");

test("all existing image preset properties survive database-schema validation without loss", () => {
    for (const family of imageModelTypes) for (const model of ["", ...Object.keys(imageModelOverrides[family])]) {
        const preset = defaultImageParameterPresets[model || `${family}-default`];
        const parsed = imageProfileSchema.safeParse(preset.profile);
        assert.ok(parsed.success, `${model || family}: ${JSON.stringify(parsed.error?.issues)}`);
        assert.deepEqual(parsed.data, preset.profile);
        for (const key of Object.keys(imageTypePresets[family])) assert.ok(Object.hasOwn(parsed.data!, key), `lost ${key}`);
        for (const key of Object.keys(imageModelOverrides[family][model] || {})) assert.ok(Object.hasOwn(parsed.data!, key), `lost override ${key}`);
    }
});
test("custom profile IDs control all OpenAI options, pixel boundaries and size mappings", () => {
    const profile = structuredClone(defaultImageParameterPresets["gpt-image-2.5-flare"].profile);
    profile.qualities = ["auto", "custom-quality"];
    profile.maxReferences = 1;
    profile.omitResponseFormat = false;
    profile.pixelBounds.step = 8;
    profile.sizePresets["1k"]["1:1"] = "1000x1000";
    const config = { callType: "openai" as const, preset: "custom-database-id", profile };
    const body = { model: "arbitrary-model", ...openAiImageParams({ model: "arbitrary-model", size: "1:1", quality: "custom-quality", background: "transparent", imageProfile: profile }) };
    assert.equal(body.size, "1000x1000"); assert.equal(body.quality, "custom-quality"); assert.equal(body.response_format, "b64_json");
    assert.equal(imageSizeFor(profile, "1k", "1:1"), "1000x1000"); assert.equal(imageRatioOf("1000x1000", profile), "1:1");
    assert.equal(imageRequestCapabilityError(body.model, config, body), "");
    assert.match(imageRequestCapabilityError(body.model, config, { ...body, images: ["a", "b"] }), /1 张/);
    profile.transparent = false;
    assert.match(imageRequestCapabilityError(body.model, config, body), /透明/);
    profile.transparent = true; profile.pixelBounds.maxEdge = 1200;
    assert.match(imageRequestCapabilityError(body.model, config, { ...body, size: "1536x864" }), /1200/);
});
test("fixed resolution and single-reference ratio lock remain configurable", () => {
    const banana = structuredClone(defaultImageParameterPresets["banana2-2k"].profile);
    assert.equal(imageProfileSchema.parse(banana).fixedResolution, "2k");
    const grok = structuredClone(defaultImageParameterPresets["grok-imagine-image-2.0"].profile);
    assert.equal("aspect_ratio" in grokImageBody("alias", "图", "16:9", "auto", 1, ["ref"], grok), false);
    grok.singleReferenceRatioLocked = false;
    assert.equal(grokImageBody("alias", "图", "16:9", "auto", 1, ["ref"], grok).aspect_ratio, "16:9");
    grok.omitResponseFormat = true;
    assert.equal("response_format" in grokImageBody("alias", "图", "16:9", "auto", 1, [], grok), false);
});
test("inconsistent defaults and pixel limits cannot be saved", () => {
    const initial: ImageProfile = structuredClone(defaultImageParameterPresets["gpt-image-2"].profile);
    for (const profile of [
        { ...initial, defaults: { ...initial.defaults, quality: "max" } },
        { ...initial, transparent: false, defaults: { ...initial.defaults, background: "transparent" } },
        { ...initial, pixelBounds: { ...initial.pixelBounds, minPixels: initial.pixelBounds.maxPixels + 1 } },
        { ...initial, sizePresets: { "1k": {} } },
    ]) assert.equal(imageProfileSchema.safeParse(profile).success, false);
});

test("each maintained pixel boundary and ratio conversion option affects the request", () => {
    const base = structuredClone(defaultImageParameterPresets["gpt-image-2"].profile);
    for (const [bounds, size, message] of [
        [{ ...base.pixelBounds, step: 32 }, "1008x1008", "32"],
        [{ ...base.pixelBounds, maxEdge: 1000 }, "1024x1024", "1000"],
        [{ ...base.pixelBounds, maxRatio: 1.5 }, "1536x864", "1.5"],
        [{ ...base.pixelBounds, minPixels: 1100000 }, "1024x1024", "1100000"],
        [{ ...base.pixelBounds, maxPixels: 1000000 }, "1024x1024", "1000000"],
    ] as const) assert.throws(() => resolveRequestSize(size, { ...base, pixelBounds: bounds }), new RegExp(message));
    base.pixelBounds.ratioShortSide = 1056;
    assert.equal(resolveRequestSize("5:4", base), "1328x1056");
});
