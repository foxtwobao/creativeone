import { expect, test } from "bun:test";
import { imageModelProfile } from "../../shared/image-models";
import { bananaImageBody } from "../src/services/api/image-adapters/banana";
import { grokImageBody } from "../src/services/api/image-adapters/grok";

test("image profiles use the explicit type even when names suggest another provider", () => {
    expect(imageModelProfile("my-private-model", "banana").family).toBe("banana");
    expect(imageModelProfile("banana-alias", "openai").pixelSize).toBe(true);
    expect(imageModelProfile("gpt-image-alias", "grok").transparent).toBe(false);
});

test("Banana sends ratio in size and lets the model suffix determine resolution", () => {
    expect(bananaImageBody("banana2-2k", "画一只猫", "3840x2160", 2, [])).toEqual({
        model: "banana2-2k", prompt: "画一只猫", size: "16:9", n: 2, response_format: "url",
    });
    expect(imageModelProfile("channel::banana2-2k", "banana").fixedResolution).toBe("2k");
    expect(imageModelProfile("banana-pro-4k", "banana").resolutions).toEqual(["auto"]);
    expect(bananaImageBody("banana2-2k", "猫", "4:5", 1, []).size).toBe("4:5");
});

test("Banana JSON references preserve data URLs and ordering in image_urls", () => {
    const images = ["data:image/jpeg;base64,YQ==", "data:image/png;base64,Yg=="];
    const body = bananaImageBody("banana-pro-4k", "合成", "1:1", 1, images);
    expect(body.image_urls).toEqual(images);
    for (const key of ["quality", "resolution", "aspect_ratio", "background", "output_format", "contents"]) expect(body).not.toHaveProperty(key);
});

test("automatic sizing leaves ratio and resolution to the provider", () => {
    expect(bananaImageBody("banana2-2k", "猫", "auto", 1, [])).toEqual({ model: "banana2-2k", prompt: "猫", n: 1, response_format: "url" });
    const request = grokImageBody("grok-imagine-image", "猫", "auto", "high", 1, []);
    expect(request).not.toHaveProperty("resolution");
    expect(request).not.toHaveProperty("aspect_ratio");
    expect(request).not.toHaveProperty("quality");
});

test("Grok editing uses JSON image/image lists and keeps all references", () => {
    const one = grokImageBody("grok-imagine-image", "猫", "2048x1152", "high", 1, ["data:image/png;base64,YQ=="]);
    expect(one).toMatchObject({ aspect_ratio: "16:9", resolution: "2k", image: { type: "image_url", url: "data:image/png;base64,YQ==" } });
    for (const key of ["size", "quality", "background", "output_format", "images"]) expect(one).not.toHaveProperty(key);
    const many = grokImageBody("grok-imagine-image-2.0", "猫", "1:1", "medium", 2, ["a", "b"]);
    expect(many).toMatchObject({ quality: "medium", n: 2, images: [{ type: "image_url", url: "a" }, { type: "image_url", url: "b" }] });
    expect(many).not.toHaveProperty("image");
});

test("switching from unsupported settings asks for a new selection instead of downgrading", () => {
    expect(() => grokImageBody("grok-imagine-image", "猫", "3840x2160", "auto", 1, [])).toThrow("分辨率");
    expect(() => grokImageBody("grok-imagine-image", "猫", "4:5", "auto", 1, [])).toThrow("宽高比");
    expect(imageModelProfile("grok-imagine-image", "grok").resolutions).not.toContain("4k");
    expect(imageModelProfile("nano-banana-pro", "banana").transparent).toBe(false);
});

test("OpenAI parameter extraction preserves generation and edit fields", async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
    const { openAiImageParams } = await import("../src/services/api/image-adapters/openai");
    const config = { model: "gpt-image-2", size: "16:9", quality: "high", background: "transparent" };
    const params = openAiImageParams(config as Parameters<typeof openAiImageParams>[0]);
    expect(params).toEqual({ quality: "high", size: "3840x2160", background: "transparent", output_format: "png" });
    expect(openAiImageParams({ ...config, model: "dall-e-3" } as Parameters<typeof openAiImageParams>[0]).response_format).toBe("b64_json");
});
