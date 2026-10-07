import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { unzipSync } from "fflate";
import { createFile } from "mp4box";
import sharp from "sharp";

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test")) throw new Error("Provide TEST_DATABASE_URL pointing at an isolated *_test database");
const media = await mkdtemp(join(tmpdir(), "creativeone-api-test-"));
const adminSubject = randomUUID();
Object.assign(process.env, {
    DATABASE_URL: database, APP_ORIGIN: "http://localhost:3001", IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test",
    IDONE_DISCOVERY_URL: "", IDONE_ALLOW_HTTP: "false", MEDIA_DOWNLOAD_HOSTS: "",
    ADMIN_SUBJECTS: adminSubject, ENHANCER_BASE_URL: "http://enhancer.test", ENHANCER_APP_CREDENTIAL: "app-test-credential", TOKENONE_BASE_URL: "https://tokenone.test",
    SESSION_SECONDS: "604800", LOGIN_SECONDS: "600", MAX_MEDIA_BYTES: "104857600", MAX_JSON_BYTES: "20971520", MEDIA_DIR: media,
});
const { app } = await import("./index.js");
const { db } = await import("./db.js");
const { env } = await import("./config.js");
const { processVideoTask, startVideoWorker } = await import("./video-tasks.js");
const { finishCanvasTask } = await import("./canvas-tasks.js");
let server: Server, base: string;
const admin = randomUUID(), alice = randomUUID(), bob = randomUUID(), unverified = randomUUID();
let imageChannel: string, textChannel: string;
const realFetch = globalThis.fetch;
const ensures: any[] = [];
const forwardedKeys: string[] = [];
const forwardedRequests: Array<{ url: string; body: any }> = [];
let denyGroup = false;
let modelFailure: { status: number; code: string } | undefined;
let videoChannel: string;
let videoCreateResponse: any = { id: "task-video", status: "queued" };
let videoQueryResponse: any = { status: "queued" };
let videoDownloadFails = false;
let videoDownloads = 0;
const fixture = createFile();
fixture.addTrack({ type: "avc1", width: 960, height: 960, timescale: 1000, media_duration: 4000, duration: 4000 });
const videoBytes = new Uint8Array(fixture.getBuffer().buffer);
const jpegBytes = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer());
let promptFetches = 0;
let promptFails = false;
let videoQueryHandler: (() => Promise<Response>) | undefined;
globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://raw.githubusercontent.com/test/prompts.json") {
        promptFetches++;
        return promptFails ? new Response("offline", { status: 503 }) : Response.json(Array.from({length: 25}, (_, i) => ({id: String(i), title: `test prompt ${i}`, prompt: `draw ${i}`, tags: ["test"]})));
    }
    if (url.startsWith("http://enhancer.test")) {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer app-test-credential");
        if (url.endsWith("/groups")) return Response.json({ app_id: "creativeone", groups: [{ id: "8", name: "应用默认组", status: "active", is_default: true }] });
        assert.equal(url, "http://enhancer.test/api/apps/keys/ensure");
        const body = JSON.parse(String(init?.body)); ensures.push(body);
        if (denyGroup) return Response.json({ error: "TOKENONE_GROUP_FORBIDDEN" }, { status: 403 });
        return Response.json({ status: "ready", tokenone_user_id: "42", api_key: { id: "701", key: `sk-${body.identity.subject}-8`, group_id: "8", status: "active" } });
    }
    if (url === "https://tokenone.test/banana-result.jpg") {
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        return new Response(jpegBytes, { headers: { "Content-Type": "image/jpeg" } });
    }
    if (url === "https://tokenone.test/video-result.mp4") {
        videoDownloads++;
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        return new Response(videoBytes, { status: videoDownloadFails ? 503 : 200, headers: { "Content-Type": "video/mp4" } });
    }
    if (url.startsWith("https://tokenone.test")) {
        forwardedKeys.push(new Headers(init?.headers).get("Authorization") || "");
        forwardedRequests.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
        if (modelFailure) return Response.json({ code: modelFailure.code, message: "private upstream details" }, { status: modelFailure.status });
        if (url.endsWith("/v1/videos") || url.endsWith("/doubao/api/v3/contents/generations/tasks")) return Response.json(videoCreateResponse);
        if (/\/(?:videos|contents\/generations\/tasks)\/task-[\w-]+$/.test(url)) return videoQueryHandler ? videoQueryHandler() : Response.json({ id: url.split("/").pop(), ...videoQueryResponse });
        if (forwardedRequests.at(-1)?.body?.model === "banana2-2k") return Response.json({ data: [{ url: "https://tokenone.test/banana-result.jpg" }] });
        if (forwardedRequests.at(-1)?.body?.model === "grok-imagine-image") return Response.json({ data: [{ url: "https://tokenone.test/banana-result.jpg", b64_json: "" }] });
        if (url.endsWith("/responses")) return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
        return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6swAAAABJRU5ErkJggg==" }] });
    }
    return realFetch(input, init);
};
const headers = (id: string) => ({ Cookie: `creativeone=${id}`, Origin: env.APP_ORIGIN, "X-CSRF-Token": `csrf-${id}`, "Content-Type": "application/json" });
const call = (path: string, id = alice, method = "GET", body?: unknown) => realFetch(`${base}/api${path}`, { method, headers: headers(id), body: body === undefined ? undefined : JSON.stringify(body) });
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
before(async () => {
    for (const id of [admin, alice, bob, unverified]) {
        await db.query("INSERT INTO users VALUES ($1,'https://idone.test',$2,$3,$4,$2,$2,'')", [id, id === admin ? adminSubject : id, `${id}@example.test`, id !== unverified]);
        await db.query("INSERT INTO sessions VALUES ($1,$2,$3,now()+interval '1 day')", [createHash("sha256").update(id).digest("hex"), id, `csrf-${id}`]);
    }
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
    globalThis.fetch = realFetch;
    server?.close();
    await db.end();
    await rm(media, { recursive: true, force: true });
});

test("anonymous requests and forged callback cannot access the application", async () => {
    assert.equal((await realFetch(`${base}/api/channels`)).status, 401);
    assert.equal((await realFetch(`${base}/api/auth/callback?code=forged&state=forged`)).status, 400);
});
test("admin role and CSRF protect channel configuration", async () => {
    assert.equal((await call("/admin/groups")).status, 403);
    assert.equal((await call("/admin/groups", admin)).status, 200);
    const body = { models: ["gpt-image-2"], image_types: { "gpt-image-2": "openai" }, default_model: "gpt-image-2", enabled: true };
    const missing = await realFetch(`${base}/api/admin/channels/image`, { method: "PUT", headers: { Cookie: `creativeone=${admin}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(missing.status, 403);
    const image = await call("/admin/channels/image", admin, "PUT", body);
    assert.equal(image.status, 200);
    imageChannel = (await image.json() as any).channel.id;
    const text = await call("/admin/channels/text", admin, "PUT", { models: ["gpt-5.5"], default_model: "gpt-5.5", enabled: true });
    assert.equal(text.status, 200);
    textChannel = (await text.json() as any).channel.id;
    assert.equal((await call("/admin/channels/image", admin, "PUT", { ...body, default_model: "not-allowed" })).status, 400);
    const updated = await (await call("/admin/channels/image", admin, "PUT", body)).json() as any;
    assert.equal(updated.channel.id, imageChannel);
});
test("feature and model cannot bypass channel capability and model routing", async () => {
    const count = ensures.length;
    assert.equal((await call(`/ai/${imageChannel}/v1/responses`, alice, "POST", { model: "gpt-image-2" })).status, 403);
    assert.equal((await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "not-allowed" })).status, 403);
    assert.equal(ensures.length, count);
});
test("image types are explicit, persisted and validated independently of model names", async () => {
    const original = { models: ["gpt-image-2"], image_types: { "gpt-image-2": "openai" }, default_model: "gpt-image-2", enabled: true };
    const config = { models: ["banana-looking-alias", "custom-image"], image_types: { "banana-looking-alias": "openai", "custom-image": "banana" }, default_model: "custom-image", enabled: true };
    try {
        assert.equal((await call("/admin/channels/image", admin, "PUT", { ...config, image_types: {} })).status, 400);
        assert.equal((await call("/admin/channels/image", admin, "PUT", { ...config, image_types: { ...config.image_types, ghost: "grok" } })).status, 400);
        assert.equal((await call("/admin/channels/image", admin, "PUT", { ...config, image_types: { ...config.image_types, "custom-image": "unknown" } })).status, 400);
        assert.equal((await call("/admin/channels/text", admin, "PUT", config)).status, 400);
        assert.equal((await call("/admin/channels/image", alice, "PUT", config)).status, 403);
        assert.equal((await call("/admin/channels/image", admin, "PUT", config)).status, 200);
        for (const path of ["/channels", "/admin/channels"]) {
            const { channels } = await (await call(path, admin)).json() as any;
            const channel = channels.find((item: any) => item.id === imageChannel);
            assert.deepEqual(channel.image_types, config.image_types);
            assert.deepEqual(channel.models, ["custom-image", "banana-looking-alias"]);
        }
        const edited = { ...config, models: ["custom-image"], image_types: { "custom-image": "grok" } };
        const response = await (await call("/admin/channels/image", admin, "PUT", edited)).json() as any;
        assert.deepEqual(response.channel.image_types, { "custom-image": "grok" });
        await db.query("UPDATE channels SET image_types='{}' WHERE id=$1", [imageChannel]);
        const before = ensures.length;
        const request = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "custom-image", prompt: "猫" });
        assert.equal(request.status, 400);
        assert.equal((await request.json() as any).error, "IMAGE_MODEL_TYPE_REQUIRED");
        assert.equal(ensures.length, before);
    } finally { await call("/admin/channels/image", admin, "PUT", original); }
});
let savedUrl = "";
test("each user's image request uses their verified identity and application group; no Key reaches the client", async () => {
    for (const id of [alice, bob]) {
        const response = await call(`/ai/${imageChannel}/v1/images/generations`, id, "POST", { model: "gpt-image-2", prompt: "test", group_id: 999, identity: { subject: "forged" } });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(!text.includes("sk-") && !text.includes("app-test-credential"));
        assert.equal(ensures.at(-1).identity.subject, id);
        assert.deepEqual(ensures.at(-1), { identity: { issuer: "https://idone.test", subject: id } });
        assert.equal(forwardedKeys.at(-1), `Bearer sk-${id}-8`);
        if (id === alice) savedUrl = JSON.parse(text).data[0].url;
    }
    assert.equal((await realFetch(`${base}${savedUrl}`, { headers: headers(alice) })).status, 200);
    assert.equal((await realFetch(`${base}${savedUrl}`, { headers: headers(bob) })).status, 404);
});
test("unverified email and forbidden groups fail without creating a replacement or calling the model", async () => {
    const before = forwardedKeys.length;
    assert.equal((await call(`/ai/${imageChannel}/v1/images/generations`, unverified, "POST", { model: "gpt-image-2" })).status, 403);
    denyGroup = true;
    const count = ensures.length;
    assert.equal((await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "gpt-image-2" })).status, 403);
    assert.equal(ensures.length, count + 1);
    assert.equal(forwardedKeys.length, before);
    denyGroup = false;
});
test("streamed text shares the application group and is saved for its owner", async () => {
    const response = await call(`/ai/${textChannel}/v1/responses`, alice, "POST", { model: "gpt-5.5", stream: true });
    assert.match(await response.text(), /你好/);
    assert.equal(forwardedKeys.at(-1), `Bearer sk-${alice}-8`);
    const { tasks } = await (await call("/tasks")).json() as any;
    assert.ok(tasks.some((task: any) => task.result?.text === "你好" && task.status === "succeeded"));
    const bobTasks = await (await call("/tasks", bob)).json() as any;
    assert.ok(!bobTasks.tasks.some((task: any) => task.result?.text === "你好"));
});
test("plugin key-value records are owner scoped and server serializes writes without client versions", async () => {
    const path = "/storage/app_state/shared-key";
    assert.equal((await call(path, alice, "PUT", { value: { title: "A" }, deleted: false })).status, 200);
    const conflict = await call(path, alice, "PUT", { value: { title: "stale" }, deleted: false });
    assert.equal(conflict.status, 200);
    assert.equal((await call(path, bob, "PUT", { value: { title: "B" }, deleted: false })).status, 200);
    const own = await (await call("/storage/app_state")).json() as any;
    assert.equal(own.entries.find((entry: any) => entry.key === "shared-key").value.title, "stale");
    assert.equal((await call(path, alice, "PUT", { value: null, deleted: true })).status, 200);
    assert.equal((await call(path, alice, "PUT", { value: { title: "resurrect" }, deleted: false })).status, 200);
});
test("documents cannot claim other users' media or browser-only object URLs", async () => {
    assert.equal((await call("/storage/app_state/foreign-file", bob, "PUT", { value: { url: savedUrl }, deleted: false })).status, 409);
    assert.equal((await call("/storage/app_state/blob", alice, "PUT", { value: JSON.stringify({ url: "blob:local-only" }), deleted: false })).status, 400);
});
test("encoded media references survive deletion requests and immutable file keys cannot be overwritten", async () => {
    const key = `image:${randomUUID()}`, path = `/files/image_files/${encodeURIComponent(key)}`;
    const upload = (bytes: string) => realFetch(`${base}/api${path}`, { method: "PUT", headers: { ...headers(alice), "Content-Type": "image/png" }, body: bytes });
    assert.equal((await upload("original")).status, 200);
    assert.equal((await upload("replacement")).status, 409);
    assert.ok(((await (await call("/files/image_files", alice)).json()) as any).keys.includes(key));
    assert.ok(!((await (await call("/files/image_files", bob)).json()) as any).keys.includes(key));
    assert.equal((await call("/storage/app_state/encoded-media", alice, "PUT", { value: { url: `/api${path}` }, deleted: false })).status, 200);
    assert.equal((await call(path, alice, "DELETE")).status, 200);
    assert.ok(!((await (await call("/files/image_files", alice)).json()) as any).keys.includes(key));
    assert.equal((await call(path)).status, 200);
    assert.equal((await call("/storage/app_state/encoded-media", alice, "PUT", { value: null, deleted: true })).status, 200);
    await call(path, alice, "DELETE");
    assert.equal((await call(path)).status, 404);
});
test("malformed JSON is rejected without a model request", async () => {
    const before = forwardedKeys.length;
    const response = await realFetch(`${base}/api/ai/${imageChannel}/v1/images/generations`, { method: "POST", headers: headers(alice), body: "{" });
    assert.equal(response.status, 400);
    assert.equal(forwardedKeys.length, before);
});
test("model failures return friendly messages and request IDs, retain specific task errors and never retry", async () => {
    for (const [status, code] of [[403, "INSUFFICIENT_BALANCE"], [401, "API_KEY_DISABLED"]] as const) {
        modelFailure = { status, code };
        const before = forwardedKeys.length;
        try {
            const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "gpt-image-2" });
            const body = await response.json() as any;
            assert.equal(response.status, 422); // Durable task failure; the specific provider code remains in the body.
            assert.equal(body.error, code);
            assert.ok(body.message);
            assert.equal(body.requestId, response.headers.get("X-Request-Id"));
            assert.doesNotMatch(JSON.stringify(body), /private upstream details/);
            assert.equal(forwardedKeys.length, before + 1);
            const task = (await db.query("SELECT status,error FROM generation_tasks WHERE id=$1", [response.headers.get("X-Generation-Task-Id")])).rows[0];
            assert.equal(task.status, "failed");
            assert.equal(task.error, code);
        } finally { modelFailure = undefined; }
    }
});
test("Banana OpenAI requests preserve parameters, image permissions, user Key and URL result storage", async () => {
    await call("/admin/channels/image", admin, "PUT", { models: ["gpt-image-2", "banana2-2k", "grok-imagine-image"], image_types: { "gpt-image-2": "openai", "banana2-2k": "banana", "grok-imagine-image": "grok" }, default_model: "gpt-image-2", enabled: true });
    const before = forwardedKeys.length;
    assert.equal((await call(`/ai/${imageChannel}/v1/chat/completions`, alice, "POST", { model: "banana2-2k" })).status, 403);
    assert.equal((await call(`/ai/${textChannel}/v1/images/generations`, alice, "POST", { model: "banana2-2k" })).status, 403);
    assert.equal(forwardedKeys.length, before);
    for (const image_urls of [[], ["data:image/png;base64,YQ==", "data:image/jpeg;base64,Yg=="]]) {
        const body = { model: "banana2-2k", prompt: "猫", size: "16:9", response_format: "url", n: 1, ...(image_urls.length ? { image_urls } : {}) };
        const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", body);
        assert.equal(response.status, 200);
        assert.deepEqual(forwardedRequests.at(-1), { url: "https://tokenone.test/v1/images/generations", body });
        assert.equal(forwardedKeys.at(-1), `Bearer sk-${alice}-8`);
        const result = await response.json() as any;
        assert.ok(result.data[0].url.startsWith("/api/files/"));
        assert.ok(!JSON.stringify(result).includes("sk-"));
        const file = await realFetch(`${base}${result.data[0].url}`, { headers: headers(alice) });
        assert.equal(file.status, 200);
        assert.match(file.headers.get("Content-Type") || "", /^image\/jpeg/);
        const task = (await db.query("SELECT status,capability,path FROM generation_tasks WHERE id=$1", [response.headers.get("X-Generation-Task-Id")])).rows[0];
        assert.deepEqual(task, { status: "succeeded", capability: "image", path: "images/generations" });
    }
});

test("Grok edits preserve JSON references and model-specific parameters", async () => {
    const body = { model: "grok-imagine-image", prompt: "猫", resolution: "2k", n: 1, response_format: "url", image: { type: "image_url", url: "data:image/png;base64,YQ==" } };
    const response = await call(`/ai/${imageChannel}/v1/images/edits`, alice, "POST", body);
    assert.equal(response.status, 200);
    assert.deepEqual(forwardedRequests.at(-1), { url: "https://tokenone.test/v1/images/edits", body });
    const result = await response.json() as any;
    const file = await realFetch(`${base}${result.data[0].url}`, { headers: headers(alice) });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("Content-Type") || "", /^image\/jpeg/);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), jpegBytes);
});

test("video model configuration exposes types and rejects mismatched protocols before upstream calls", async () => {
    const config = { models: ["seedance-test", "wan3.0-video-720p", "wan3.0-image-prime-480p"], default_model: "seedance-test", enabled: true,
        video_types: { "seedance-test": "seedance", "wan3.0-video-720p": "wan", "wan3.0-image-prime-480p": "wan" } };
    assert.equal((await call("/admin/channels/video", admin, "PUT", { ...config, video_types: {} })).status, 400);
    assert.equal((await call("/admin/channels/video", admin, "PUT", { ...config, video_types: { ...config.video_types, extra: "wan" } })).status, 400);
    const response = await call("/admin/channels/video", admin, "PUT", config);
    assert.equal(response.status, 200);
    videoChannel = (await response.json() as any).channel.id;
    const { channels } = await (await call("/channels")).json() as any;
    assert.deepEqual(channels.find((item: any) => item.id === videoChannel).video_types, config.video_types);
    const before = forwardedRequests.length;
    assert.equal((await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", { model: "seedance-test" })).status, 403);
    assert.equal((await call(`/ai/${videoChannel}/v1/contents/generations/tasks`, alice, "POST", { model: "wan3.0-video-720p" })).status, 403);
    const wan = { model: "wan3.0-image-prime-480p", prompt: "图1", seconds: "5", aspect_ratio: "1:1", reference_images: [{ url: "https://example.test/image.jpg" }] };
    for (const body of [
        { ...wan, reference_videos: [{ url: "https://example.test/video.mp4" }] },
        { ...wan, input: { media: [{ type: "video", url: "https://example.test/video.mp4" }] } },
        { ...wan, reference_images: [{ url: "data:image/png;base64,YQ==" }] },
        { ...wan, reference_images: Array(11).fill(wan.reference_images[0]) },
    ]) assert.equal((await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", body)).status, 400);
    assert.equal(forwardedRequests.length, before);
});

test("media signing enforces ownership, expiry, signatures and supports unauthenticated HEAD/Range", async () => {
    const previousOrigin = env.APP_ORIGIN;
    const realNow = Date.now;
    try {
        env.APP_ORIGIN = "https://creativeone.test";
        const key = `video:${randomUUID()}`;
        const path = `/files/media_files/${key}`;
        assert.equal((await realFetch(`${base}/api${path}`, { method: "PUT", headers: { ...headers(alice), "Content-Type": "video/mp4" }, body: "abcdefgh" })).status, 200);
        assert.equal((await call("/files/sign", bob, "POST", { namespace: "media_files", key })).status, 404);
        assert.equal((await realFetch(`${base}/api/files/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ namespace: "media_files", key }) })).status, 401);
        const signed = await call("/files/sign", alice, "POST", { namespace: "media_files", key });
        assert.equal(signed.status, 200);
        const url = new URL((await signed.json() as any).url);
        assert.equal(url.origin, env.APP_ORIGIN);
        const ttl = Number(url.searchParams.get("expires")) - realNow();
        assert.ok(ttl > 29 * 60_000 && ttl <= 30 * 60_000);
        const local = `${base}${url.pathname}${url.search}`;
        assert.equal((await realFetch(local, { method: "HEAD" })).status, 200);
        const range = await realFetch(local, { headers: { Range: "bytes=2-4" } });
        assert.equal(range.status, 206);
        assert.equal(await range.text(), "cde");
        const forged = new URL(local);
        forged.searchParams.set("expires", String(Number(url.searchParams.get("expires")) + 1));
        assert.equal((await realFetch(forged)).status, 403);
        Date.now = () => realNow() + 31 * 60_000;
        assert.equal((await realFetch(local)).status, 403);
        Date.now = realNow;
        assert.equal((await call(path, alice, "DELETE")).status, 200);
        assert.equal((await realFetch(local)).status, 404);
    } finally { env.APP_ORIGIN = previousOrigin; Date.now = realNow; }
});

test("WAN and Seedance task IDs remain isolated by protocol and user, with locally persisted results", async () => {
    videoCreateResponse = { id: "task-shared", status: "queued" };
    const body = { model: "wan3.0-video-720p", prompt: "猫", seconds: "5", aspect_ratio: "16:9" };
    const wan = await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", body);
    assert.equal(wan.status, 200);
    assert.equal(forwardedRequests.at(-1)?.url, "https://tokenone.test/v1/videos");
    assert.equal(forwardedKeys.at(-1), `Bearer sk-${alice}-8`);
    const seedance = await call(`/ai/${videoChannel}/v1/contents/generations/tasks`, alice, "POST", { model: "seedance-test", content: [{ type: "text", text: "猫" }] });
    assert.equal(seedance.status, 200);
    assert.equal(forwardedRequests.at(-1)?.url, "https://tokenone.test/doubao/api/v3/contents/generations/tasks");
    const wanPath = `/ai/${videoChannel}/v1/videos/task-shared`;
    assert.equal((await call(wanPath, bob)).status, 404);
    videoQueryResponse = { status: "completed", metadata: { url: "https://tokenone.test/video-result.mp4" } };
    await processVideoTask(wan.headers.get("X-Generation-Task-Id")!);
    const completed = await (await call(wanPath)).json() as any;
    assert.match(completed.metadata.url, /^\/api\/files\/media_files\//);
    assert.equal(completed.file.url, completed.metadata.url);
    assert.equal(completed.file.bytes, videoBytes.byteLength);
    assert.equal(completed.file.width, 960);
    assert.equal(completed.file.height, 960);
    assert.equal(completed.file.durationMs, 4000);
    assert.equal((await realFetch(`${base}${completed.metadata.url}`, { headers: headers(bob) })).status, 404);
    const count = forwardedRequests.length;
    assert.deepEqual(await (await call(wanPath)).json(), completed);
    assert.equal(forwardedRequests.length, count);
    videoQueryResponse = { status: "succeeded", content: { video_url: "https://tokenone.test/video-result.mp4" } };
    await processVideoTask(seedance.headers.get("X-Generation-Task-Id")!);
    const ark = await (await call(`/ai/${videoChannel}/v1/contents/generations/tasks/task-shared`)).json() as any;
    assert.match(ark.content.video_url, /^\/api\/files\/media_files\//);
    const { tasks } = await (await call("/tasks")).json() as any;
    assert.ok(tasks.some((task: any) => task.path === "videos" && task.upstream_id === "task-shared" && task.status === "succeeded"));
});

test("instant completion and temporary query/download failures retain the same WAN task without resubmission", async () => {
    videoCreateResponse = { id: "task-instant", status: "completed", metadata: { url: "https://tokenone.test/video-result.mp4" } };
    videoQueryResponse = { status: "completed", metadata: { url: "https://tokenone.test/video-result.mp4" } };
    const downloads = videoDownloads;
    const created = await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", { model: "wan3.0-video-720p", prompt: "猫", seconds: "5", aspect_ratio: "adaptive" });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { id: "task-instant", status: "queued" });
    assert.equal(videoDownloads, downloads);
    const taskId = created.headers.get("X-Generation-Task-Id");
    const task = () => db.query("SELECT status,upstream_id,error FROM generation_tasks WHERE id=$1", [taskId]).then((result) => result.rows[0]);
    const path = `/ai/${videoChannel}/v1/videos/task-instant`;
    const posts = forwardedRequests.filter((request) => request.url.endsWith("/v1/videos")).length;
    try {
        modelFailure = { status: 503, code: "UNAVAILABLE" };
        await processVideoTask(taskId!);
        assert.equal((await (await call(path)).json() as any).status, "paused");
        assert.equal((await task()).status, "unknown");
        modelFailure = undefined;
        videoDownloadFails = true;
        assert.equal((await call(`${path}/resume`, bob, "POST", {})).status, 404);
        await call(`${path}/resume`, alice, "POST", {});
        await processVideoTask(taskId!);
        assert.equal((await (await call(path)).json() as any).status, "paused");
        assert.equal((await task()).upstream_id, "task-instant");
        videoDownloadFails = false;
        await call(`${path}/resume`, alice, "POST", {});
        await processVideoTask(taskId!);
        assert.equal((await call(path)).status, 200);
        assert.deepEqual(await task(), { status: "succeeded", upstream_id: "task-instant", error: null });
        assert.equal(forwardedRequests.filter((request) => request.url.endsWith("/v1/videos")).length, posts);
    } finally { modelFailure = undefined; videoDownloadFails = false; }
});

test("browser reads never trigger upstream queries and concurrent worker calls save one file", async () => {
    for (const wan of [true, false]) {
        const endpoint = wan ? "videos" : "contents/generations/tasks";
        videoCreateResponse = { id: `task-concurrent-${wan}`, status: "queued" };
        const created = await call(`/ai/${videoChannel}/v1/${endpoint}`, alice, "POST", wan
            ? { model: "wan3.0-video-720p", prompt: "猫", seconds: "5", aspect_ratio: "adaptive" }
            : { model: "seedance-test", content: [{ type: "text", text: "猫" }] });
        const id = created.headers.get("X-Generation-Task-Id")!;
        const arrived = deferred(), gate = deferred();
        let queries = 0;
        const downloads = videoDownloads;
        const files = Number((await db.query("SELECT count(*) FROM files")).rows[0].count);
        videoQueryHandler = async () => {
            queries++; arrived.resolve(); await gate.promise;
            return Response.json(wan ? { status: "completed", metadata: { url: "https://tokenone.test/video-result.mp4" } } : { status: "succeeded", content: { video_url: "https://tokenone.test/video-result.mp4" } });
        };
        try {
            const path = `/ai/${videoChannel}/v1/${endpoint}/${videoCreateResponse.id}`;
            await Promise.all([call(path), call(path)]);
            assert.equal(queries, 0);
            const worker = processVideoTask(id);
            await arrived.promise;
            assert.equal(processVideoTask(id), worker);
            const waiting = await Promise.all([call(path), call(path)]);
            assert.ok((await Promise.all(waiting.map((response) => response.json()))).every((result: any) => result.status === "queued"));
            assert.equal(queries, 1);
            gate.resolve(); await worker;
            const responses = await Promise.all([call(path), call(path)]);
            const [first, second] = await Promise.all(responses.map((response) => response.json()));
            assert.deepEqual(first, second);
            assert.equal(queries, 1);
            assert.equal(videoDownloads - downloads, 1);
            assert.equal(Number((await db.query("SELECT count(*) FROM files")).rows[0].count) - files, 1);
        } finally { videoQueryHandler = undefined; gate.resolve(); }
    }
});

test("late worker responses and errors cannot overwrite an already completed task", async () => {
    for (const late of ["pending", "http-error", "transport-error"]) {
        videoCreateResponse = { id: `task-late-${late}`, status: "queued" };
        const created = await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", { model: "wan3.0-video-720p", prompt: "猫", seconds: "5", aspect_ratio: "adaptive" });
        const id = created.headers.get("X-Generation-Task-Id")!;
        const arrived = deferred(), release = deferred();
        videoQueryHandler = async () => {
            arrived.resolve(); await release.promise;
            if (late === "transport-error") throw new Error("connection lost");
            return late === "pending" ? Response.json({ status: "queued" }) : Response.json({ error: "unavailable" }, { status: 503 });
        };
        try {
            const work = processVideoTask(id); await arrived.promise;
            const completed = { id: videoCreateResponse.id, status: "completed", file: { url: "/api/files/media_files/file:completed" } };
            await db.query("UPDATE generation_tasks SET status='succeeded',result=$2,error=NULL WHERE id=$1", [id, JSON.stringify(completed)]);
            release.resolve(); await work;
            const task = (await db.query("SELECT status,error,result FROM generation_tasks WHERE id=$1", [id])).rows[0];
            assert.equal(task.status, "succeeded"); assert.equal(task.error, null); assert.deepEqual(task.result, completed);
        } finally { videoQueryHandler = undefined; release.resolve(); }
    }
});

test("the 5-second worker resumes pending tasks on startup without a browser and skips paused tasks", async (t) => {
    const originalInterval = globalThis.setInterval;
    t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => { assert.equal(ms, 5000); return originalInterval(callback, ms); });
    videoCreateResponse = { id: "task-background", status: "queued" };
    const created = await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", { model: "wan3.0-video-720p", prompt: "猫", seconds: "5", aspect_ratio: "adaptive" });
    const id = created.headers.get("X-Generation-Task-Id")!;
    const posts = forwardedRequests.filter((request) => request.url.endsWith("/v1/videos")).length;
    let stop = async () => {};
    try {
        let arrived = deferred();
        videoQueryHandler = async () => { arrived.resolve(); return Response.json({ status: "queued" }); };
        stop = startVideoWorker(); await arrived.promise; await processVideoTask(id); await stop();
        assert.equal((await db.query("SELECT status FROM generation_tasks WHERE id=$1", [id])).rows[0].status, "pending");
        arrived = deferred();
        videoQueryHandler = async () => { arrived.resolve(); return Response.json({ status: "completed", metadata: { url: "https://tokenone.test/video-result.mp4" } }); };
        stop = startVideoWorker(); await arrived.promise; await processVideoTask(id); await stop();
        const task = (await db.query("SELECT status,result FROM generation_tasks WHERE id=$1", [id])).rows[0];
        assert.equal(task.status, "succeeded"); assert.equal(task.result.file.width, 960);
        assert.ok((await db.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [alice, task.result.file.storageKey])).rowCount);
        assert.equal(forwardedRequests.filter((request) => request.url.endsWith("/v1/videos")).length, posts);
        await db.query("UPDATE generation_tasks SET status='unknown' WHERE id=$1", [id]);
        const queries = forwardedRequests.length;
        await processVideoTask(id);
        assert.equal(forwardedRequests.length, queries);
    } finally { await stop(); videoQueryHandler = undefined; }
});

test("model descriptions are admin-managed, preserved verbatim and never change upstream model IDs", async () => {
    const model = "wan3.0-video-720p";
    const description = "团队常用型号\n请先确认参考素材";
    const body = { models: [model], video_types: { [model]: "wan" }, model_descriptions: { [model]: description }, default_model: model, enabled: true };
    assert.equal((await call("/admin/channels/video", alice, "PUT", body)).status, 403);
    assert.equal((await call("/admin/channels/video", admin, "PUT", { ...body, model_descriptions: { unconfigured: description } })).status, 400);
    assert.equal((await call("/admin/channels/video", admin, "PUT", body)).status, 200);
    const configured = (await (await call("/admin/channels", admin)).json() as any).channels.find((item: any) => item.capability === "video");
    assert.deepEqual(configured.model_descriptions, { [model]: description });
    const visible = (await (await call("/channels", alice)).json() as any).channels.find((item: any) => item.capability === "video");
    assert.equal(visible.model_display, undefined);
    assert.deepEqual(visible.model_descriptions, { [model]: description });
    assert.deepEqual(visible.models, [model]);
    videoCreateResponse = { id: "display-task", status: "queued" };
    assert.equal((await call(`/ai/${videoChannel}/v1/videos`, alice, "POST", { model, prompt: "猫", seconds: "5", aspect_ratio: "adaptive" })).status, 200);
    assert.equal((forwardedRequests.at(-1)?.body as any).model, model);
    assert.equal((await call("/admin/channels/video", admin, "PUT", { ...body, model_descriptions: {} })).status, 200);
    const cleared = (await (await call("/channels", alice)).json() as any).channels.find((item: any) => item.capability === "video");
    assert.deepEqual(cleared.model_descriptions, {});
});

test("removing a finished work is owner-scoped and never cancels a live task", async () => {
    const finished = randomUUID(), pending = randomUUID();
    const provider = (await import("./tokenone.js")).modelProvider;
    for (const [id, status] of [[finished, "succeeded"], [pending, "pending"]]) {
        await db.query("INSERT INTO generation_tasks(id,user_id,channel_id,group_id,model,capability,path,status,provider,result) VALUES($1,$2,$3,'1','fixture','video','videos',$4,$5,$6)", [id, alice, videoChannel, status, provider, JSON.stringify({ metadata: { url: "/saved-video" } })]);
    }
    assert.equal((await call(`/tasks/${finished}`, bob, "DELETE")).status, 409);
    assert.equal((await call(`/tasks/${pending}`, alice, "DELETE")).status, 409);
    assert.equal((await call(`/tasks/${finished}`, alice, "DELETE")).status, 200);
    assert.equal((await call(`/tasks/${finished}`, alice, "DELETE")).status, 200);
    const tasks = (await (await call("/tasks", alice)).json()).tasks;
    assert.ok(!tasks.some((task: any) => task.id === finished));
    assert.ok(tasks.some((task: any) => task.id === pending));
    const saved = (await db.query("SELECT status,result,hidden_from_works FROM generation_tasks WHERE id=$1", [finished])).rows[0];
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.result.metadata.url, "/saved-video");
    assert.equal(saved.hidden_from_works, true);
});

test("image previews are small, cached, owner-scoped and cleaned up with the original", async () => {
    const sharp = (await import("sharp")).default;
    const { stat } = await import("node:fs/promises");
    const bytes = await sharp(randomBytes(2048 * 1024 * 3), { raw: { width: 2048, height: 1024, channels: 3 } }).png().toBuffer();
    const path = "/files/image_files/image:preview-test";
    const uploaded = await realFetch(`${base}/api${path}`, { method: "PUT", headers: { ...headers(alice), "Content-Type": "image/png" }, body: bytes });
    assert.equal(uploaded.status, 200);
    const preview = await call(`${path}?preview=1`, alice);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type")!, /image\/webp/);
    assert.equal(preview.headers.get("cache-control"), "private, no-cache");
    const thumbnail = Buffer.from(await preview.arrayBuffer());
    const info = await sharp(thumbnail).metadata();
    assert.equal(info.width, 768); assert.equal(info.height, 384);
    assert.ok(thumbnail.length < bytes.length);
    const cached = await realFetch(`${base}/api${path}?preview=1`, { headers: { ...headers(alice), "If-None-Match": preview.headers.get("etag")!, "Cache-Control": "max-age=0" } });
    assert.equal(cached.status, 304);
    assert.equal((await call(`${path}?preview=1`, bob)).status, 404);
    assert.equal((await realFetch(`${base}/api${path}?preview=1`)).status, 401);
    assert.deepEqual(Buffer.from(await (await call(path, alice)).arrayBuffer()), bytes);
    const disk = (await db.query("SELECT disk_id FROM files WHERE user_id=$1 AND key='image:preview-test'", [alice])).rows[0].disk_id;
    assert.equal((await call(path, alice, "DELETE")).status, 200);
    await assert.rejects(stat(join(media, `${disk}.preview.webp`)), { code: "ENOENT" });
});

test("status polling returns only owned visible task IDs and statuses", async () => {
    const id = randomUUID();
    const provider = (await import("./tokenone.js")).modelProvider;
    await db.query("INSERT INTO generation_tasks(id,user_id,channel_id,group_id,model,capability,path,status,provider,result) VALUES($1,$2,$3,'1','fixture','video','videos','pending',$4,$5)", [id, alice, videoChannel, provider, JSON.stringify({ large: "x".repeat(20000) })]);
    const upstreamCount = forwardedRequests.length;
    const response = await call("/tasks/status", alice, "POST", { ids: [id] });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(body), { tasks: [{ id, status: "pending" }] });
    assert.ok(Buffer.byteLength(body) < 100);
    assert.deepEqual(await (await call("/tasks/status", bob, "POST", { ids: [id] })).json(), { tasks: [] });
    await db.query("UPDATE generation_tasks SET status='succeeded' WHERE id=$1", [id]);
    assert.deepEqual(await (await call("/tasks/status", alice, "POST", { ids: [id] })).json(), { tasks: [{ id, status: "succeeded" }] });
    await db.query("UPDATE generation_tasks SET hidden_from_works=true WHERE id=$1", [id]);
    assert.deepEqual(await (await call("/tasks/status", alice, "POST", { ids: [id] })).json(), { tasks: [] });
    assert.equal(forwardedRequests.length, upstreamCount);
});

test("asset operations are owner-scoped and concurrent changes preserve other assets and fields", async () => {
    const input = { kind: "text", title: "one", coverUrl: "", tags: [], data: { content: "original" } };
    const created = await Promise.all([call("/assets", alice, "POST", input), call("/assets", alice, "POST", { ...input, title: "two" })]);
    assert.ok(created.every((response) => response.status === 201));
    const [one, two] = await Promise.all(created.map(async (response) => (await response.json()).asset));
    assert.notEqual(one.id, two.id); assert.ok(one.createdAt);
    const updates = await Promise.all([call(`/assets/${one.id}`, alice, "PATCH", { title: "updated" }), call(`/assets/${one.id}`, alice, "PATCH", { note: "parallel" })]);
    assert.ok(updates.every((response) => response.status === 200));
    const list = (await (await call("/assets", alice)).json()).assets;
    assert.equal(list.find((asset: any) => asset.id === one.id).title, "updated");
    assert.equal(list.find((asset: any) => asset.id === one.id).note, "parallel");
    assert.ok(list.some((asset: any) => asset.id === two.id));
    assert.deepEqual((await (await call("/assets", bob)).json()).assets, []);
    assert.equal((await call(`/assets/${one.id}`, bob, "PATCH", { title: "stolen" })).status, 404);
    assert.equal((await call(`/assets/${one.id}`, bob, "DELETE")).status, 404);
    assert.equal((await call(`/assets/${one.id}`, alice, "PATCH", { id: two.id })).status, 400);
    assert.equal((await call("/assets", alice, "POST", { ...input, coverUrl: "blob:local" })).status, 400);
    assert.equal((await call("/storage/app_state/infinite-canvas:asset_store", alice, "PUT", { value: "{}", deleted: false })).status, 410);
    assert.ok(!(await (await call("/storage/app_state", alice)).json()).entries.some((entry: any) => entry.key === "infinite-canvas:asset_store"));
    assert.equal((await call(`/assets/${one.id}`, alice, "DELETE")).status, 204);
    const remaining = (await (await call("/assets", alice)).json()).assets;
    assert.ok(!remaining.some((asset: any) => asset.id === one.id));
    assert.ok(remaining.some((asset: any) => asset.id === two.id));
});

test("project commands enforce ownership, versions and idempotency", async () => {
    const responses = await Promise.all([call("/projects", alice, "POST", { title: "first" }), call("/projects", alice, "POST", { title: "second" })]);
    assert.ok(responses.every((r) => r.status === 201));
    const projects = await Promise.all(responses.map(async (r) => (await r.json()).project));
    const operationId = randomUUID();
    const command = { operationId, baseRevision: projects[0].contentRevision, command: { type: "edit_project", patch: { title: "renamed" }, graphEdits: [] } };
    const first = await call(`/projects/${projects[0].id}/commands`, alice, "POST", command);
    assert.equal(first.status, 200);
    const replay = await call(`/projects/${projects[0].id}/commands`, alice, "POST", command);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), await first.clone().json());
    const stale = await call(`/projects/${projects[0].id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: projects[0].contentRevision, command: { type: "edit_project", patch: { viewport: {x: 5, y: 7, k: 2} }, graphEdits: [] } });
    assert.equal(stale.status, 409);
    const current = (await first.json()).project;
    const update = await call(`/projects/${projects[0].id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: current.contentRevision, command: { type: "edit_project", patch: { viewport: {x: 5, y: 7, k: 2} }, graphEdits: [] } });
    assert.equal(update.status, 200);
    const receipts = await db.query("SELECT result FROM canvas_project_commands WHERE project_id=$1", [projects[0].id]);
    assert.ok(receipts.rows.every(({ result }: any) => Object.keys(result).sort().join(",") === "contentRevision,generationRevision"));
    const replayAfterViewport = await call(`/projects/${projects[0].id}/commands`, alice, "POST", command);
    assert.equal(replayAfterViewport.status, 200);
    assert.equal((await replayAfterViewport.json()).project.viewport.k, 2);
    const list = (await (await call("/projects")).json()).projects;
    assert.equal(list.find((p: any) => p.id === projects[0].id).title, "renamed");
    assert.equal("nodes" in list[0], false);
    assert.equal((await (await call(`/projects/${projects[0].id}`)).json()).project.viewport.k, 2);
    assert.equal((await update.json()).project.contentRevision, current.contentRevision);
    assert.ok(list.some((p: any) => p.id === projects[1].id));
    assert.equal((await call(`/projects/${projects[0].id}/commands`, bob, "POST", { operationId: randomUUID(), baseRevision: 1, command: { type: "edit_project", patch: {title: "stolen"}, graphEdits: [] } })).status, 404);
    await Promise.all([call("/settings", alice, "PATCH", { quality: "high" }), call("/settings", alice, "PATCH", {size: "1:1"})]);
    assert.deepEqual(await (await call("/settings")).json(), {quality: "high", size: "1:1"});
    assert.equal((await call("/settings", alice, "PATCH", {apiKey: "secret"})).status, 400);
    await db.query("UPDATE documents SET value=$2 WHERE user_id=$1 AND namespace='preferences' AND key='infinite-canvas:ai_config_store'", [alice, JSON.stringify(JSON.stringify({state:{config:{quality:"high",size:"1:1",apiKey:"must-not-leak",channels:[{apiKey:"must-not-leak"}]}},version:0}))]);
    assert.deepEqual(await (await call("/settings")).json(), {quality:"high",size:"1:1"});
    for (const [ns, key] of [["app_state", "canvas_store"], ["app_state", "plugin_store"], ["app_state", "prompt_source_store_v2"], ["preferences", "ai_config_store"]]) {
        assert.equal((await call(`/storage/${ns}/infinite-canvas:${key}`, alice, "PUT", {value: "{}", deleted: false})).status, 410);
    }
    assert.equal((await call(`/projects/${projects[0].id}`, alice, "DELETE")).status, 204);
    assert.ok((await (await call("/projects")).json()).projects.some((p: any) => p.id === projects[1].id));
});
test("file references are read on the server and original generation settings survive page changes", async () => {
    const key = `image:${randomUUID()}`, url = `/api/files/image_files/${key}`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6swAAAABJRU5ErkJggg==", "base64");
    assert.equal((await realFetch(`${base}${url}`, { method: "PUT", headers: {...headers(alice), "Content-Type": "image/png"}, body: png })).status, 200);
    assert.equal((await call("/files/info", bob, "POST", {url})).status, 404);
    const filesBefore = (await db.query("SELECT count(*) FROM files WHERE user_id=$1", [alice])).rows[0].count;
    const response = await call(`/ai/${imageChannel}/v1/images/edits`, alice, "POST", {model: "gpt-image-2", prompt: "reuse on server with reference instruction", user_prompt: "reuse on server", n: 1, quality: "high", image_references: [url]});
    assert.equal(response.status, 200);
    const forwarded = forwardedRequests.at(-1)!.body as FormData;
    assert.ok(forwarded instanceof FormData); assert.equal((forwarded.get("image") as Blob).size, png.length);
    assert.equal(forwarded.get("user_prompt"), null);
    assert.equal(forwarded.get("prompt"), "reuse on server with reference instruction");
    assert.equal((await db.query("SELECT count(*) FROM files WHERE user_id=$1", [alice])).rows[0].count, String(Number(filesBefore)+1));
    const history = await (await call("/history/image?keyword=reuse%20on%20server")).json();
    assert.equal(history.total, 1); assert.equal(history.logs[0].config.quality, "high"); assert.equal(history.logs[0].references[0].dataUrl, url);
    assert.equal(history.logs[0].prompt, "reuse on server");
    const taskRequest = (await db.query("SELECT request FROM generation_tasks WHERE id=$1", [history.logs[0].id])).rows[0].request;
    assert.equal(taskRequest.prompt, "reuse on server with reference instruction");
    assert.equal(taskRequest.user_prompt, "reuse on server");
    assert.ok(history.logs[0].images[0].storageKey);
    assert.equal((await call(`/ai/${imageChannel}/v1/images/edits`, bob, "POST", {model: "gpt-image-2", prompt: "foreign", image_references: [url]})).status, 404);
    await call(`/history/${history.logs[0].id}`, alice, "DELETE");
    assert.equal((await (await call("/history/image?keyword=reuse%20on%20server")).json()).total, 0);
    assert.equal((await call("/storage/image_generation_logs/old", alice, "PUT", {value: {}, deleted: false})).status, 410);
});
test("original prompt metadata stays local for JSON generation and appears in task search", async () => {
    const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", {model: "gpt-image-2", prompt: "system instruction\n\ndraw an otter", user_prompt: "draw an otter", n: 1, size: "1024x1024"});
    assert.equal(response.status, 200);
    assert.equal(forwardedRequests.at(-1)!.body.prompt, "system instruction\n\ndraw an otter");
    assert.equal(forwardedRequests.at(-1)!.body.user_prompt, undefined);
    const works = await (await call("/works?view=tasks&keyword=draw%20an%20otter")).json();
    assert.equal(works.total, 1);
    assert.equal(works.works[0].task.request.user_prompt, "draw an otter");
    assert.equal((await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", {model: "gpt-image-2", prompt: "x", user_prompt: {apiKey: "invalid"}})).status, 400);
});
async function canvasOutput(node: any, channel: string, model: string, prompt: string) {
    const { project } = await (await call("/projects", alice, "POST", { title: "canvas output" })).json();
    node.metadata = { ...node.metadata, model: `${channel}::${model}`, prompt, size: "1024x1024", quality: "auto", videoSize: "auto", vquality: "720", seconds: "6", references: [] };
    const response = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "edit_project", patch: {}, graphEdits: [{ type: "put_node", node }] } });
    assert.equal(response.status, 200);
    return (await response.json()).project;
}
test("canvas acceptance is durable, owner scoped and idempotent; the worker uses saved input", async () => {
    const { executeMediaTask } = await import("./generation-executor.js");
    const node = { id: "output-node", type: "image", title: "output", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { generationId: randomUUID(), status: "loading" } };
    const project = await canvasOutput(node, imageChannel, "gpt-image-2", "canvas image");
    const body = { model: "gpt-image-2", prompt: "ignored browser prompt", n: 1, size: "1024x1024" };
    const canvas_context = { projectId: project.id, nodeId: node.id, generationId: node.metadata.generationId, outputIndex: 0 };
    const before = forwardedRequests.length;
    assert.equal((await call(`/ai/${imageChannel}/v1/images/generations`, bob, "POST", { ...body, canvas_context })).status, 404);
    const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { ...body, canvas_context });
    assert.equal(response.status, 202);
    assert.equal(forwardedRequests.length, before);
    const taskId = (await response.json()).canvasTaskId;
    const accepted = (await db.query("SELECT status,canvas_node_id FROM generation_tasks WHERE id=$1", [taskId])).rows[0];
    assert.equal(accepted.status, "pending");
    assert.equal(accepted.canvas_node_id, project.nodes[0].entityId);
    await Promise.all([executeMediaTask(taskId), executeMediaTask(taskId)]);
    assert.equal(forwardedRequests.length, before + 1);
    assert.equal(forwardedRequests.at(-1)!.body.prompt, "canvas image");
    assert.ok(!("canvas_context" in forwardedRequests.at(-1)!.body));
    assert.ok(!("canvas_source" in forwardedRequests.at(-1)!.body));
    const saved = (await (await call(`/projects/${project.id}`)).json()).project;
    assert.equal(saved.nodes[0].metadata.status, "success");
    assert.equal(saved.nodes[0].width, 100);
    const replay = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { ...body, canvas_context });
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).canvasTaskId, taskId);
    assert.equal(replay.headers.get("X-Generation-Task-Id"), taskId);
    assert.equal(forwardedRequests.length, before + 1);
    const renamed = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "edit_project", patch: {}, graphEdits: [{ type: "put_node", node: { ...node, title: "edited during generation", position: { x: 42, y: 18 }, width: 240, height: 160 } }] } });
    assert.equal(renamed.status, 200);
    const updated = (await renamed.json()).project;
    assert.equal(updated.nodes[0].metadata.content, saved.nodes[0].metadata.content);
    assert.equal(updated.nodes[0].width, 240);
    assert.equal((await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, command: { type: "edit_project", patch: { title: "stale edit" }, graphEdits: [] } })).status, 409);
});
test("obsolete completion does not replace a new output or revive a deleted node", async () => {
    const { executeMediaTask } = await import("./generation-executor.js");
    const node = { id: "late-output", type: "image", title: "output", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { generationId: randomUUID(), status: "loading" } };
    const project = await canvasOutput(node, imageChannel, "gpt-image-2", "late");
    const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "gpt-image-2", prompt: "late", size: "1024x1024", canvas_context: { projectId: project.id, nodeId: node.id, generationId: node.metadata.generationId } });
    const taskId = (await response.json()).canvasTaskId;
    await executeMediaTask(taskId);
    const saved = (await (await call(`/projects/${project.id}`)).json()).project;
    const replacement = { ...saved.nodes[0], metadata: { ...node.metadata, generationId: randomUUID(), status: "loading" } };
    const change = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: saved.contentRevision, baseGenerationRevision: saved.generationRevision, command: { type: "edit_project", patch: {}, graphEdits: [{ type: "put_node", node: replacement }] } });
    assert.equal(change.status, 200);
    await db.query("UPDATE generation_tasks SET canvas_attached=false WHERE id=$1", [taskId]);
    await finishCanvasTask(taskId);
    const current = (await (await call(`/projects/${project.id}`)).json()).project;
    assert.equal(current.nodes[0].metadata.generationId, replacement.metadata.generationId);
    assert.equal(current.nodes[0].metadata.content, undefined);
    assert.equal((await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "edit_project", patch: {}, graphEdits: [{ type: "delete_node", id: node.id }] } })).status, 200);
    await db.query("UPDATE generation_tasks SET canvas_attached=false WHERE id=$1", [taskId]);
    await finishCanvasTask(taskId);
    assert.deepEqual((await (await call(`/projects/${project.id}`)).json()).project.nodes, []);
});
test("a live worker lock prevents restart recovery; an abandoned call becomes unknown without resubmission", async () => {
    const { executeMediaTask } = await import("./generation-executor.js");
    const node = { id: "owned-output", type: "image", title: "output", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { generationId: randomUUID(), status: "loading" } };
    const project = await canvasOutput(node, imageChannel, "gpt-image-2", "worker owner");
    const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "gpt-image-2", canvas_context: { projectId: project.id, nodeId: node.id, generationId: node.metadata.generationId } });
    const taskId = (await response.json()).canvasTaskId, owner = await db.connect(), before = forwardedRequests.length;
    try {
        await owner.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [taskId]);
        await db.query("UPDATE generation_tasks SET status='running',execution_token=$2 WHERE id=$1", [taskId, randomUUID()]);
        await executeMediaTask(taskId);
        assert.equal((await db.query("SELECT status FROM generation_tasks WHERE id=$1", [taskId])).rows[0].status, "running");
    } finally { await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [taskId]); owner.release(); }
    await executeMediaTask(taskId);
    assert.equal((await db.query("SELECT status FROM generation_tasks WHERE id=$1", [taskId])).rows[0].status, "unknown");
    assert.equal(forwardedRequests.length, before);
});
test("canvas video results attach through the worker without a canvas result write", async () => {
    const { executeMediaTask } = await import("./generation-executor.js");
    videoCreateResponse = { id: "task-canvas-video", status: "queued" };
    videoQueryResponse = { status: "succeeded", content: { video_url: "https://tokenone.test/video-result.mp4" } };
    const node = { id: "video-output", type: "video", title: "video", position: { x: 21, y: 35 }, width: 240, height: 135, metadata: { generationId: randomUUID(), status: "loading" } };
    try {
        const project = await canvasOutput(node, videoChannel, "seedance-test", "video");
        const response = await call(`/ai/${videoChannel}/v1/contents/generations/tasks`, alice, "POST", { model: "seedance-test", content: [{ type: "text", text: "video" }], canvas_context: { projectId: project.id, nodeId: node.id, generationId: node.metadata.generationId } });
        assert.equal(response.status, 202);
        const taskId = (await response.json()).canvasTaskId;
        await executeMediaTask(taskId); await processVideoTask(taskId);
        const saved = (await (await call(`/projects/${project.id}`)).json()).project;
        assert.equal(saved.nodes[0].metadata.status, "success");
        assert.match(saved.nodes[0].metadata.content, /^\/api\/files\/media_files\//);
        assert.deepEqual(saved.nodes[0].position, node.position);
        assert.equal(saved.nodes[0].width, node.width);
        const revision = saved.contentRevision;
        await finishCanvasTask(taskId);
        assert.equal((await (await call(`/projects/${project.id}`)).json()).project.contentRevision, revision);
    } finally { videoCreateResponse = { id: "task-video", status: "queued" }; videoQueryResponse = { status: "queued" }; }
});
test("undoing a deletion restores its server identity and the latest task result without generating again", async () => {
    const { executeMediaTask } = await import("./generation-executor.js");
    const node = { id: "undo-output", type: "image", title: "output", position: { x: 12, y: 24 }, width: 200, height: 100, metadata: { generationId: randomUUID(), status: "loading" } };
    let project = await canvasOutput(node, imageChannel, "gpt-image-2", "undo result");
    const entityId = project.nodes[0].entityId;
    const accepted = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "gpt-image-2", canvas_context: { projectId: project.id, nodeId: node.id, generationId: node.metadata.generationId } });
    const taskId = (await accepted.json()).canvasTaskId;
    project = (await (await call(`/projects/${project.id}`)).json()).project;
    const sourceOperationId = randomUUID();
    const edit = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: sourceOperationId, baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "delete_node", id: node.id }] } });
    assert.equal(edit.status, 200);
    project = (await edit.json()).project;
    await executeMediaTask(taskId);
    assert.deepEqual((await (await call(`/projects/${project.id}`)).json()).project.nodes, []);
    const calls = forwardedRequests.length;
    const undo = { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "restore_edit", sourceOperationId, direction: "undo" } };
    const restored = await call(`/projects/${project.id}/commands`, alice, "POST", undo);
    assert.equal(restored.status, 200);
    project = (await restored.json()).project;
    assert.equal(project.nodes[0].entityId, entityId);
    assert.equal(project.nodes[0].metadata.status, "success");
    assert.equal(project.nodes[0].metadata.generationTaskId, taskId);
    assert.deepEqual(project.nodes[0].position, node.position);
    assert.equal((await (await call(`/projects/${project.id}/commands`, alice, "POST", undo)).json()).project.contentRevision, project.contentRevision);
    const redo = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "restore_edit", sourceOperationId, direction: "redo" } });
    assert.equal(redo.status, 200);
    assert.deepEqual((await redo.json()).project.nodes, []);
    assert.equal(forwardedRequests.length, calls);
});
test("undo rejects a later edit of the same node", async () => {
    let project = await canvasOutput({ id: "undo-conflict", type: "text", title: "original", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "text" } }, imageChannel, "gpt-image-2", "text");
    const sourceOperationId = randomUUID();
    for (const [index, title] of ["first edit", "second edit"].entries()) {
        const edited = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: index ? randomUUID() : sourceOperationId, baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "put_node", node: { ...project.nodes[0], title } }] } });
        assert.equal(edited.status, 200); project = (await edited.json()).project;
    }
    const result = await call(`/projects/${project.id}/commands`, alice, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "restore_edit", sourceOperationId, direction: "undo" } });
    assert.equal(result.status, 409);
    assert.equal((await (await call(`/projects/${project.id}`)).json()).project.nodes[0].title, "second edit");
});
test("recovering a saved upstream image response does not call the model again", async () => {
    const { executeMediaTask } = await import("./generation-executor.js");
    const node = { id: "recover-output", type: "image", title: "output", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { generationId: randomUUID(), status: "loading" } };
    const project = await canvasOutput(node, imageChannel, "gpt-image-2", "recover saved image");
    const response = await call(`/ai/${imageChannel}/v1/images/generations`, alice, "POST", { model: "gpt-image-2", canvas_context: { projectId: project.id, nodeId: node.id, generationId: node.metadata.generationId } });
    const taskId = (await response.json()).canvasTaskId;
    await db.query("UPDATE generation_tasks SET status='unknown',upstream_result=$2,error='MEDIA_DOWNLOAD_FAILED' WHERE id=$1", [taskId, JSON.stringify({ data: [{ url: "https://tokenone.test/banana-result.jpg" }] })]);
    await finishCanvasTask(taskId);
    assert.equal((await call(`/tasks/${taskId}/resume-result`, bob, "POST", {})).status, 409);
    assert.equal((await call(`/tasks/${taskId}/resume-result`, alice, "POST", {})).status, 202);
    const before = forwardedRequests.length;
    await executeMediaTask(taskId);
    assert.equal(forwardedRequests.length, before);
    const saved = (await (await call(`/projects/${project.id}`)).json()).project;
    assert.equal(saved.nodes[0].metadata.status, "success");
    assert.equal((await db.query("SELECT upstream_result FROM generation_tasks WHERE id=$1", [taskId])).rows[0].upstream_result, null);
});
test("archive validation rejects missing media, temporary URLs and dangling graph references", async () => {
    const project = { title: "import", nodes: [] as any[], connections: [] as any[], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "lines", showImageInfo: false };
    const archive = { app: "infinite-canvas", version: 4, exportedAt: "test", projects: [{ project, files: [] }] };
    assert.equal((await call("/projects/archive/validate", alice, "POST", archive)).status, 200);
    assert.equal((await call("/projects/archive/validate", alice, "POST", { ...archive, version: 3 })).status, 400);
    project.nodes = [{ id: "media", type: "image", title: "media", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:missing", content: "/api/files/image_files/image%3Amissing" } }];
    assert.equal((await call("/projects/archive/validate", alice, "POST", archive)).status, 400);
    project.nodes[0].metadata = { references: ["https://example.test/public/media/id?signature=secret"] };
    assert.equal((await call("/projects/archive/validate", alice, "POST", archive)).status, 400);
    project.nodes[0].metadata = {};
    project.connections = [{ id: "edge", fromNodeId: "media", toNodeId: "missing" }];
    assert.equal((await call("/projects/archive/validate", alice, "POST", archive)).status, 400);
});
test("server cleanup preserves another project reference and export streams one owned ZIP", async () => {
    const key = `image:${randomUUID()}`, url = `/api/files/image_files/${key}`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6swAAAABJRU5ErkJggg==", "base64");
    await realFetch(`${base}${url}`, {method: "PUT", headers: {...headers(alice), "Content-Type": "image/png"}, body: png});
    const info = await (await call("/files/info", alice, "POST", {url})).json();
    const asset = (await (await call("/assets", alice, "POST", {kind: "image", title: "zip image", coverUrl: url, tags: [], data: {...info, dataUrl: url, url: undefined}})).json()).asset;
    assert.ok(asset?.id);
    const project = (await (await call("/projects", alice, "POST", {title: "keep image", nodes: [{ id: "keep-image", type: "image", title: "keep image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: url, storageKey: key } }]})).json()).project;
    const response = await call("/assets/export"); assert.equal(response.status, 200);
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(archive["assets.json"]));
    const file = manifest.files.find((f: any) => f.storageKey === key);
    assert.deepEqual(Buffer.from(archive[file.path]), png);
    assert.ok(!JSON.stringify(manifest).includes("diskId"));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await (await call("/assets/export", bob)).arrayBuffer()))["assets.json"])).assets, []);
    await call(`/assets/${asset.id}`, alice, "DELETE");
    const coverAsset = (await (await call("/assets", alice, "POST", {kind: "text", title: "cover only", coverUrl: url, tags: [], data: {content: "text"}})).json()).asset;
    const coverZip = unzipSync(new Uint8Array(await (await call("/assets/export")).arrayBuffer()));
    const coverManifest = JSON.parse(new TextDecoder().decode(coverZip["assets.json"]));
    assert.ok(coverManifest.files.some((f: any) => f.storageKey === key));
    await call(`/assets/${coverAsset.id}`, alice, "DELETE");
    await call("/files/cleanup", alice, "POST", {}); assert.equal((await realFetch(`${base}${url}`, {headers: headers(alice)})).status, 200);
    await call(`/projects/${project.id}`, alice, "DELETE");
    assert.equal((await realFetch(`${base}${url}`, {headers: headers(alice)})).status, 404);
});
test("prompt caching, refresh and pagination run on the server and retain cache after failure", async () => {
    const state = await (await call("/prompt-sources")).json();
    for (const source of state.sources) await call(`/prompt-sources/${source.id}`, alice, "PATCH", {enabled: false});
    const saved = await (await call("/prompt-sources", alice, "POST", {name: "test source", url: "https://raw.githubusercontent.com/test/prompts.json", homepage: "", enabled: true})).json();
    const source = saved.sources.find((s: any) => s.name === "test source"); assert.ok(source.id);
    const first = await (await call(`/prompts?sourceId=${source.id}&pageSize=10`)).json();
    assert.equal(first.total, 25); assert.equal(first.items.length, 10); assert.equal(promptFetches, 1);
    const second = await (await call(`/prompts?sourceId=${source.id}&pageSize=10&page=2`)).json();
    assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(promptFetches, 1);
    assert.equal((await (await call(`/prompts?sourceId=${source.id}&keyword=draw%2024`)).json()).total, 1);
    promptFails = true;
    const result = await (await call("/prompt-sources/refresh", alice, "POST", {sourceId: source.id})).json();
    assert.equal(result.failureCount, 1);
    assert.equal((await (await call(`/prompts?sourceId=${source.id}`)).json()).total, 25);
    promptFails = false;
    const { refreshDuePromptSources } = await import("./prompts.js");
    await db.query("UPDATE prompt_caches SET last_attempt_at=now()-interval '1 hour' WHERE user_id=$1 AND source_id=$2", [alice, source.id]);
    const before = promptFetches;
    await refreshDuePromptSources(); assert.equal(promptFetches, before+1);
    await refreshDuePromptSources(); assert.equal(promptFetches, before+1);
    assert.deepEqual(await (await call("/prompt-source-statuses", bob)).json(), {});
    await call("/prompt-schedule", alice, "PATCH", {intervalMinutes: 0});
    assert.equal((await (await call("/prompt-sources")).json()).schedule.intervalMinutes, 0);
    await db.query("UPDATE prompt_caches SET last_attempt_at=now()-interval '1 hour' WHERE user_id=$1 AND source_id=$2", [alice, source.id]);
    await refreshDuePromptSources(); assert.equal(promptFetches, before+1);
    await call(`/prompt-sources/${source.id}`, alice, "DELETE");
    assert.equal((await (await call(`/prompts?sourceId=${source.id}`)).json()).total, 0);
});
test("plugin records and works filtering use server mutations and pagination", async () => {
    const record = {id: "test-plugin", name: "test", version: "1", url: "https://example.test/plugin.js", source: "export default {}", enabled: true};
    assert.equal((await call("/plugins", alice, "POST", record)).status, 403);
    assert.equal((await call(`/plugins/${record.id}`, alice, "PATCH", {enabled: true})).status, 403);
    assert.deepEqual((await (await call("/plugins", bob)).json()).plugins, []);
    const response = await (await call("/works?view=tasks&status=failed&pageSize=1")).json();
    assert.ok(response.works.length <= 1); assert.ok(response.works.every((w: any) => w.task.status === "failed"));
    assert.ok(response.total > 1);
    const next = await (await call("/works?view=tasks&status=failed&pageSize=1&page=2")).json();
    assert.notEqual(response.works[0].id, next.works[0].id);
});

test("account switching and logout invalidate stale clients", async () => {
    const changed = await realFetch(`${base}/api/tasks`, { headers: { ...headers(bob), "X-Expected-User": alice } });
    assert.equal(changed.status, 409);
    assert.equal((await call("/auth/logout", bob, "POST")).status, 200);
    assert.equal((await call("/tasks", bob)).status, 401);
});
