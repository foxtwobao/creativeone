import { afterAll, beforeAll, expect, test } from "bun:test";
import { cloudSession, initializeCloud } from "./api/cloud";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let images: typeof import("./image-storage");
const requests: string[] = [];
beforeAll(async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
    globalThis.fetch = (async (input) => {
        const path = String(input);
        requests.push(path);
        if (path === "/api/auth/me") return Response.json({ user: { id: "alice" }, csrf: "csrf", maxReferenceImageBytes: 10485760 });
        if (path === "/api/channels") return Response.json({ channels: [] });
        if (path === "/api/model-authorization") return Response.json(null);
        if (path === "/api/files/info") return Response.json({ bytes: 10485761 });
        throw new Error(`Unexpected network request: ${path}`);
    }) as typeof fetch;
    await initializeCloud();
    images = await import("./image-storage");
});
afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
test("oversize local image is rejected before uploading or decoding", async () => {
    requests.length = 0;
    await expect(images.uploadImage(new Blob([new Uint8Array(10485761)], { type: "image/jpeg" }))).rejects.toThrow("10 MiB");
    expect(requests).toEqual([]);
});
test("existing reference is checked using metadata without downloading original", async () => {
    requests.length = 0;
    await expect(images.imageToDataUrl({ storageKey: "image:large" })).rejects.toThrow("10 MiB");
    expect(requests).toEqual(["/api/files/info"]);
});
test("server supplied limit accepts exact boundary and rejects one extra byte", () => {
    const previous = cloudSession!.maxReferenceImageBytes;
    try {
        cloudSession!.maxReferenceImageBytes = 20971520;
        expect(() => images.assertReferenceImageSize(20971520)).not.toThrow();
        expect(() => images.assertReferenceImageSize(20971521)).toThrow("20 MiB");
    } finally { cloudSession!.maxReferenceImageBytes = previous; }
});
