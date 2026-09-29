import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test")) throw new Error("Provide TEST_DATABASE_URL pointing at an isolated *_test database");
const media = await mkdtemp(join(tmpdir(), "creativeone-api-test-"));
const adminSubject = randomUUID();
Object.assign(process.env, {
    DATABASE_URL: database, APP_ORIGIN: "http://localhost:3001", IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test",
    ADMIN_SUBJECTS: adminSubject, ENHANCER_BASE_URL: "http://enhancer.test", ENHANCER_APP_CREDENTIAL: "app-test-credential", TOKENONE_BASE_URL: "https://tokenone.test",
    SESSION_SECONDS: "604800", LOGIN_SECONDS: "600", MAX_MEDIA_BYTES: "104857600", MAX_JSON_BYTES: "20971520", MEDIA_DIR: media,
});
const { app } = await import("./index.js");
const { db } = await import("./db.js");
let server: Server, base: string;
const admin = randomUUID(), alice = randomUUID(), bob = randomUUID(), unverified = randomUUID();
let imageChannel: string, textChannel: string;
const realFetch = globalThis.fetch;
const ensures: any[] = [];
const forwardedKeys: string[] = [];
const forwardedRequests: Array<{ url: string; body: any }> = [];
let denyGroup = false;
let modelFailure: { status: number; code: string } | undefined;
globalThis.fetch = async (input, init) => {
    const url = String(input);
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
        return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg" } });
    }
    if (url.startsWith("https://tokenone.test")) {
        forwardedKeys.push(new Headers(init?.headers).get("Authorization") || "");
        forwardedRequests.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
        if (modelFailure) return Response.json({ code: modelFailure.code, message: "private upstream details" }, { status: modelFailure.status });
        if (forwardedRequests.at(-1)?.body?.model === "banana2-2k") return Response.json({ data: [{ url: "https://tokenone.test/banana-result.jpg" }] });
        if (forwardedRequests.at(-1)?.body?.model === "grok-imagine-image") return Response.json({ data: [{ url: "https://tokenone.test/banana-result.jpg", b64_json: "" }] });
        if (url.endsWith("/responses")) return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
        return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6swAAAABJRU5ErkJggg==" }] });
    }
    return realFetch(input, init);
};
const headers = (id: string) => ({ Cookie: `creativeone=${id}`, Origin: "http://localhost:3001", "X-CSRF-Token": `csrf-${id}`, "Content-Type": "application/json" });
const call = (path: string, id = alice, method = "GET", body?: unknown) => realFetch(`${base}/api${path}`, { method, headers: headers(id), body: body === undefined ? undefined : JSON.stringify(body) });
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
test("cloud records are isolated, optimistic versions reject stale edits and tombstones reject resurrection", async () => {
    const path = "/storage/app_state/shared-key";
    assert.equal((await call(path, alice, "PUT", { revision: 0, value: { title: "A" }, deleted: false })).status, 200);
    const conflict = await call(path, alice, "PUT", { revision: 0, value: { title: "stale" }, deleted: false });
    assert.equal(conflict.status, 409);
    assert.equal((await call(path, bob, "PUT", { revision: 0, value: { title: "B" }, deleted: false })).status, 200);
    const own = await (await call("/storage/app_state")).json() as any;
    assert.equal(own.entries.find((entry: any) => entry.key === "shared-key").value.title, "A");
    assert.equal((await call(path, alice, "PUT", { revision: 1, value: null, deleted: true })).status, 200);
    assert.equal((await call(path, alice, "PUT", { revision: 1, value: { title: "resurrect" }, deleted: false })).status, 409);
});
test("documents cannot claim other users' media or browser-only object URLs", async () => {
    assert.equal((await call("/storage/app_state/foreign-file", bob, "PUT", { revision: 0, value: { url: savedUrl }, deleted: false })).status, 409);
    assert.equal((await call("/storage/app_state/blob", alice, "PUT", { revision: 0, value: JSON.stringify({ url: "blob:local-only" }), deleted: false })).status, 400);
});
test("encoded media references survive deletion requests and immutable file keys cannot be overwritten", async () => {
    const key = `image:${randomUUID()}`, path = `/files/image_files/${encodeURIComponent(key)}`;
    const upload = (bytes: string) => realFetch(`${base}/api${path}`, { method: "PUT", headers: { ...headers(alice), "Content-Type": "image/png" }, body: bytes });
    assert.equal((await upload("original")).status, 200);
    assert.equal((await upload("replacement")).status, 409);
    assert.ok(((await (await call("/files/image_files", alice)).json()) as any).keys.includes(key));
    assert.ok(!((await (await call("/files/image_files", bob)).json()) as any).keys.includes(key));
    assert.equal((await call("/storage/app_state/encoded-media", alice, "PUT", { revision: 0, value: { url: `/api${path}` }, deleted: false })).status, 200);
    assert.equal((await call(path, alice, "DELETE")).status, 200);
    assert.ok(!((await (await call("/files/image_files", alice)).json()) as any).keys.includes(key));
    assert.equal((await call(path)).status, 200);
    assert.equal((await call("/storage/app_state/encoded-media", alice, "PUT", { revision: 1, value: null, deleted: true })).status, 200);
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
            assert.equal(response.status, status === 401 ? 502 : status);
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
    const body = { model: "grok-imagine-image", prompt: "猫", aspect_ratio: "16:9", resolution: "2k", n: 1, response_format: "url", image: { type: "image_url", url: "data:image/png;base64,YQ==" } };
    const response = await call(`/ai/${imageChannel}/v1/images/edits`, alice, "POST", body);
    assert.equal(response.status, 200);
    assert.deepEqual(forwardedRequests.at(-1), { url: "https://tokenone.test/v1/images/edits", body });
    const result = await response.json() as any;
    const file = await realFetch(`${base}${result.data[0].url}`, { headers: headers(alice) });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("Content-Type") || "", /^image\/jpeg/);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([255, 216, 255, 217]));
});

test("account switching and logout invalidate stale clients", async () => {
    const changed = await realFetch(`${base}/api/tasks`, { headers: { ...headers(bob), "X-Expected-User": alice } });
    assert.equal(changed.status, 409);
    assert.equal((await call("/auth/logout", bob, "POST")).status, 200);
    assert.equal((await call("/tasks", bob)).status, 401);
});
