import { test, after } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused_test", APP_ORIGIN: "https://creative.test",
    ENHANCER_BASE_URL: "https://reseller.test", APP_ORIGINS: '["https://creative.test"]',
    IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "test",
    MAX_REFERENCE_IMAGE_BYTES: "10485760",
});
const { assertReferenceImageSize, assertReferenceImages } = await import("./storage.js");
const { db } = await import("./db.js");
const { env } = await import("./config.js");
after(() => db.end());
const tooLarge = { status: 413, code: "REFERENCE_IMAGE_TOO_LARGE" };
test("reference limit uses decoded bytes and applies independently to each image", async () => {
    const uri = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes).toString("base64")}`;
    await assertReferenceImages("alice", { images: [{ url: uri(10485760) }, { url: uri(10485760) }] });
    await assert.rejects(assertReferenceImages("alice", { image: { url: uri(10485761) } }), tooLarge);
});
test("stored references check account-owned image metadata without reading file contents", async () => {
    const client = { query: async (sql: string, args: unknown[]) => {
        assert.match(sql, /user_id=\$1/);
        assert.match(sql, /mime_type LIKE 'image\/%'/);
        assert.deepEqual(args, ["alice", ["image:large"]]);
        return { rows: [{ bytes: "10485761" }] };
    } } as unknown as Pick<typeof db, "query">;
    await assert.rejects(assertReferenceImages("alice", { image_references: ["/api/files/image_files/image%3Alarge"] }, client), tooLarge);
});
test("configured reference limit replaces default without changing media result limit", () => {
    const previous = env.MAX_REFERENCE_IMAGE_BYTES;
    try {
        env.MAX_REFERENCE_IMAGE_BYTES = 20971520;
        assert.doesNotThrow(() => assertReferenceImageSize(20971520));
        assert.throws(() => assertReferenceImageSize(20971521), tooLarge);
        assert.equal(env.MAX_MEDIA_BYTES, 104857600);
    } finally { env.MAX_REFERENCE_IMAGE_BYTES = previous; }
});
