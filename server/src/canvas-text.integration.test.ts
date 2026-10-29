import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test")) throw new Error("Provide an isolated *_test database");
const media = await mkdtemp(join(tmpdir(), "creativeone-text-test-"));
const alice = randomUUID(), bob = randomUUID();
Object.assign(process.env, { DATABASE_URL: database, APP_ORIGIN: "http://localhost:3001", APP_ORIGINS: '["http://localhost:3001"]', APP_DOMAIN_SUFFIXES: "", IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", IDONE_DISCOVERY_URL: "", IDONE_ALLOW_HTTP: "false", ADMIN_SUBJECTS: alice, ENHANCER_BASE_URL: "https://enhancer.test", ENHANCER_APP_CREDENTIAL: "test", TOKENONE_BASE_URL: "https://tokenone.test", MEDIA_DOWNLOAD_HOSTS: "", MEDIA_DIR: media });
const { app } = await import("./index.js");
const { db } = await import("./db.js");
const { loginSites } = await import("./config.js");
const { executeMediaTask } = await import("./generation-executor.js");
const realFetch = globalThis.fetch;
let server: Server, base = "", channel = "", fail = false;
let response: any = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "生成的分镜" }] }] };
const requests: any[] = [];
globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://enhancer.test/api/apps/keys/ensure") return Response.json({ status: "ready", tokenone_user_id: "42", api_key: { id: "701", key: "sk-test-only", group_id: "8", status: "active" } });
    if (url === "https://tokenone.test/v1/responses") {
        requests.push(JSON.parse(String(init?.body)));
        if (fail) throw new TypeError("connection lost");
        return Response.json(response);
    }
    return realFetch(input, init);
};
const call = (path: string, method = "GET", body?: unknown, user = alice) => realFetch(`${base}/api${path}`, { method, headers: { Cookie: `creativeone=${user}`, Origin: "http://localhost:3001", "X-CSRF-Token": `csrf-${user}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const project = async (id: string) => (await (await call(`/projects/${id}`)).json() as any).project;
const task = async (id: string) => (await db.query("SELECT * FROM generation_tasks WHERE id=$1", [id])).rows[0];
const edit = async (current: any, node: any) => {
    const result = await call(`/projects/${current.id}/commands`, "POST", { operationId: randomUUID(), baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "put_node", node }] } });
    assert.equal(result.status, 200, await result.clone().text());
    return (await result.json() as any).project;
};
async function setup() {
    const created = await call("/projects", "POST", { title: "文本画布", nodes: [{ id: "text", type: "text", title: "原始标题", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { prompt: "已保存提示词", model: `${channel}::text-model`, reasoningEffort: "low" } }] });
    assert.equal(created.status, 201, await created.clone().text());
    let current = (await created.json() as any).project;
    const node = current.nodes[0];
    const texts = ["a", "b"].map((id) => ({ id, generationId: randomUUID(), content: "", status: "loading" }));
    current = await edit(current, { ...node, metadata: { ...node.metadata, texts, primaryTextId: "a", status: "loading" } });
    const body = (index: number) => ({ model: "text-model", input: "客户端伪造正文", stream: true, canvas_context: { projectId: current.id, nodeId: node.id, outputId: texts[index].id, generationId: texts[index].generationId } });
    const submit = async (index: number) => {
        const result = await call(`/ai/${channel}/v1/responses`, "POST", body(index));
        assert.equal(result.status, 202, await result.clone().text());
        return (await result.json() as any).canvasTaskId;
    };
    return { current, node, texts, body, submit };
}
before(async () => {
    for (const id of [alice, bob]) {
        await db.query("INSERT INTO users VALUES ($1,'https://idone.test',$2,$3,true,$2,$2,'')", [id, id, `${id}@example.test`]);
        await db.query("INSERT INTO sessions(id_hash,user_id,csrf,expires_at,origin) VALUES($1,$2,$3,now()+interval '1 day','http://localhost:3001')", [createHash("sha256").update(id).digest("hex"), id, `csrf-${id}`]);
    }
    server = await new Promise<Server>((resolve) => { const current = app.listen(0, "127.0.0.1", () => resolve(current)); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    loginSites.set(new URL(base).host, { origin: "http://localhost:3001" });
    const configured = await call("/admin/channels/text", "PUT", { models: ["text-model"], default_model: "text-model", enabled: true });
    assert.equal(configured.status, 200, await configured.clone().text());
    channel = (await configured.json() as any).channel.id;
});
after(async () => { globalThis.fetch = realFetch; await new Promise<void>((resolve) => server.close(() => resolve())); await db.end(); await rm(media, { recursive: true, force: true }); });

test("text tasks enforce ownership, deduplicate slots, use saved inputs and attach independent results", async () => {
    const { current, body, submit } = await setup();
    assert.equal((await call(`/ai/${channel}/v1/responses`, "POST", body(0), bob)).status, 404);
    const first = await submit(0), second = await submit(1);
    assert.equal(await submit(0), first);
    const latest = await project(current.id);
    await edit(latest, { ...latest.nodes[0], title: "生成期间修改标题", position: { x: 80, y: 90 } });
    await executeMediaTask(first);
    assert.deepEqual(requests.at(-1), { model: "text-model", stream: false, reasoning: { effort: "low" }, input: [{ role: "user", content: [{ type: "input_text", text: "已保存提示词" }] }] });
    let saved = await project(current.id);
    assert.equal(saved.nodes[0].metadata.content, "生成的分镜");
    assert.equal(saved.nodes[0].metadata.status, "loading");
    const changed = saved.nodes[0];
    changed.metadata.content = "用户修改分镜";
    changed.metadata.texts[0] = { ...changed.metadata.texts[0], content: "用户修改分镜", edited: true };
    await edit(saved, changed);
    await executeMediaTask(second);
    saved = await project(current.id);
    assert.equal(saved.nodes[0].metadata.content, "用户修改分镜");
    assert.equal(saved.nodes[0].metadata.texts[1].content, "生成的分镜");
    assert.equal(saved.nodes[0].metadata.status, "success");
    assert.equal(saved.nodes[0].title, "生成期间修改标题");
    assert.deepEqual(saved.nodes[0].position, { x: 80, y: 90 });
    assert.equal((await task(first)).status, "succeeded");
    assert.equal((await (await call(`/projects/${current.id}/task-status`)).json() as any).tasks.length, 2);
});
test("transport uncertainty is not retried and unaccepted slots recover without calling upstream", async () => {
    const { current, submit } = await setup();
    const id = await submit(0);
    fail = true;
    await executeMediaTask(id);
    fail = false;
    const count = requests.length;
    await executeMediaTask(id);
    assert.equal(requests.length, count);
    assert.equal((await task(id)).status, "unknown");
    const saved = await project(current.id);
    assert.equal(saved.nodes[0].metadata.status, "error");
    assert.ok(saved.nodes[0].metadata.texts.every((text: any) => text.status === "error"));
});
test("incomplete and empty responses do not become successful text", async () => {
    for (const payload of [{ status: "incomplete", output_text: "部分内容" }, { status: "completed", output: [] }]) {
        const { submit } = await setup();
        const id = await submit(0);
        response = payload;
        await executeMediaTask(id);
        assert.equal((await task(id)).status, "failed");
        assert.equal((await task(id)).error, "INVALID_TEXT_RESPONSE");
    }
});

test("image references expand on the server and saved responses recover without another model call", async () => {
    const { saveFile } = await import("./storage.js");
    const { default: sharp } = await import("sharp");
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const url = await saveFile(alice, "image_files", `text-reference:${randomUUID()}`, bytes, "image/png");
    const { current, submit } = await setup();
    await edit(current, { ...current.nodes[0], metadata: { ...current.nodes[0].metadata, references: [url] } });
    response = { status: "completed", output_text: "图中是红色" };
    const first = await submit(0);
    await executeMediaTask(first);
    assert.ok(requests.at(-1).input[0].content[1].image_url.startsWith("data:image/png;base64,"));
    const second = await submit(1);
    await db.query("UPDATE generation_tasks SET status='running',execution_token=$2,upstream_result=$3 WHERE id=$1", [second, randomUUID(), JSON.stringify(response)]);
    const count = requests.length;
    await executeMediaTask(second);
    assert.equal(requests.length, count);
    assert.equal((await task(second)).status, "succeeded");
});
test("a deleted output is not recreated when its accepted text task finishes", async () => {
    const { current, submit } = await setup();
    const id = await submit(0);
    const latest = await project(current.id);
    const removed = await call(`/projects/${current.id}/commands`, "POST", { operationId: randomUUID(), baseRevision: latest.contentRevision, baseGenerationRevision: latest.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "delete_node", id: latest.nodes[0].id }] } });
    assert.equal(removed.status, 200, await removed.clone().text());
    await executeMediaTask(id);
    assert.deepEqual((await project(current.id)).nodes, []);
    assert.equal((await task(id)).canvas_attached, true);
});
