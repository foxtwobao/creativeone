import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { defaultSpeechInput, defaultMusicInput } from "../../shared/audio.js";
import { taskMedia } from "../../shared/works.js";
import { audioDispatcher, AUDIO_REQUEST_TIMEOUT_MS } from "./audio.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test")) throw new Error("Provide TEST_DATABASE_URL pointing at an isolated *_test database");
const media = await mkdtemp(join(tmpdir(), "creativeone-audio-test-"));
const admin = randomUUID(), alice = randomUUID(), bob = randomUUID();
Object.assign(process.env, { DATABASE_URL: database, APP_ORIGIN: "http://localhost:3001", APP_ORIGINS: '["http://localhost:3001"]', APP_DOMAIN_SUFFIXES: "", IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", IDONE_DISCOVERY_URL: "", IDONE_ALLOW_HTTP: "false", ADMIN_SUBJECTS: admin, ENHANCER_BASE_URL: "https://enhancer.test", ENHANCER_APP_CREDENTIAL: "test", TOKENONE_BASE_URL: "https://tokenone.test", MEDIA_DOWNLOAD_HOSTS: "", MEDIA_DIR: media });
const { app } = await import("./index.js");
const { db } = await import("./db.js");
const { loginSites } = await import("./config.js");
const { executeMediaTask } = await import("./generation-executor.js");
const realFetch = globalThis.fetch;
const [wavBytes, mp3Bytes, m4aBytes] = await Promise.all(["audio.wav", "audio.mp3", "audio-opus.mp4"].map((name) => readFile(new URL(`./fixtures/${name}`, import.meta.url))));
const upstream: any[] = [], downloads: string[] = [];
let response: any, failUrl = "", transportFailure = false, base = "", channel = "", server: Server;
const completion = (urls: string[], type = "suno") => ({ id: "chat-only-for-diagnostics", choices: [{ finish_reason: "stop", message: { content: type === "suno" ? urls.map((url) => `[音频](${url})`).join("\n") : urls.map((url) => `<audio src="${url.replaceAll("&", "&amp;")}"></audio>`).join("\n") } }], ...(type === "suno" ? { data: urls.map((url) => ({ url, format: "m4a" })) } : {}) });
globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://enhancer.test/api/apps/keys/ensure") return Response.json({ status: "ready", tokenone_user_id: "42", api_key: { id: "701", key: "sk-private-audio", group_id: "8", status: "active" } });
    if (url === "https://tokenone.test/v1/chat/completions") {
        upstream.push(JSON.parse(String(init?.body)));
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer sk-private-audio");
        assert.equal((init as RequestInit & { dispatcher?: unknown })?.dispatcher, audioDispatcher);
        init?.signal?.throwIfAborted();
        if (transportFailure) throw new TypeError("network lost after dispatch");
        return Response.json(response);
    }
    if (url.startsWith("https://tokenone.test/audio/")) {
        downloads.push(url);
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        assert.equal(init?.redirect, "error");
        assert.ok((await db.query("SELECT 1 FROM generation_tasks WHERE upstream_result IS NOT NULL")).rowCount);
        const bytes = url.endsWith("/not-audio.html") ? Buffer.from("<html>expired audio link</html>") : url.includes(".wav") ? wavBytes : url.includes(".mp3") ? mp3Bytes : m4aBytes;
        return new Response(bytes, { status: url === failUrl ? 503 : 200, headers: { "Content-Type": "audio/mp4" } });
    }
    return realFetch(input, init);
};
const headers = (id: string) => ({ Cookie: `creativeone=${id}`, Origin: "http://localhost:3001", "X-CSRF-Token": `csrf-${id}`, "Content-Type": "application/json" });
const call = (path: string, method = "GET", body?: unknown, user = alice) => realFetch(`${base}/api${path}`, { method, headers: headers(user), body: body === undefined ? undefined : JSON.stringify(body) });
const request = (type = "suno", input: any = { ...defaultMusicInput, description: "钢琴" }) => ({ model: type, audio_type: type, audio_input: input, submission_id: randomUUID(), title: "原始名称" });
const submit = async (body: any, user = alice) => {
    const accepted = await call(`/ai/${channel}/v1/chat/completions`, "POST", body, user);
    assert.equal(accepted.status, 202, await accepted.clone().text());
    return (await accepted.json() as any).canvasTaskId as string;
};
const task = async (id: string) => (await db.query("SELECT * FROM generation_tasks WHERE id=$1", [id])).rows[0];
before(async () => {
    for (const id of [admin, alice, bob]) {
        await db.query("INSERT INTO users VALUES ($1,'https://idone.test',$2,$3,true,$2,$2,'')", [id, id, `${id}@example.test`]);
        await db.query("INSERT INTO sessions(id_hash,user_id,csrf,expires_at,origin) VALUES($1,$2,$3,now()+interval '1 day','http://localhost:3001')", [createHash("sha256").update(id).digest("hex"), id, `csrf-${id}`]);
    }
    server = await new Promise<Server>((resolve) => { const current = app.listen(0, "127.0.0.1", () => resolve(current)); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    loginSites.set(new URL(base).host, { origin: "http://localhost:3001" });
    const audio_types = { suno: "suno", lyria: "lyria", "gemini-tts": "gemini-tts", "gemini-3.8-flash-tts": "gemini-tts", "lyria-3.5": "lyria", "lyria-3-pro-preview": "lyria", "suno-v6-mini": "suno" };
    const configured = await call("/admin/channels/audio", "PUT", { models: Object.keys(audio_types), default_model: "suno", enabled: true, audio_types }, admin);
    assert.equal(configured.status, 200);
    channel = (await configured.json() as any).channel.id;
});
after(async () => { globalThis.fetch = realFetch; server?.close(); await db.end(); await rm(media, { recursive: true, force: true }); });

test("documented models preserve request fields and save their actual audio formats", async () => {
    const speech = { ...structuredClone(defaultSpeechInput), text: "请用温柔自然的语气朗读：你好，世界。", voice: "Leda" };
    const music = { ...defaultMusicInput, description: "钢琴与弦乐", lyrics: "[Verse]\n晚风" };
    const cases = [
        { model: "gemini-3.8-flash-tts", type: "gemini-tts", input: speech, content: speech.text, fields: { output_format: "url", audio: { voice: "Leda", format: "wav" } } },
        { model: "gemini-3.8-flash-tts", type: "gemini-tts", input: { ...speech, mode: "duo", text: "Joe：你好。\nJane: 欢迎。", speakers: [{ name: "Joe", voice: "Puck" }, { name: "Jane", voice: "Kore" }] }, content: "Joe：你好。\nJane: 欢迎。", fields: { output_format: "url", audio: { format: "wav" }, speakers: [{ name: "Joe", voice: "Puck" }, { name: "Jane", voice: "Kore" }] } },
        ...["lyria-3.5", "lyria-3-pro-preview"].flatMap((model) => [
            { model, type: "lyria", input: music, content: "钢琴与弦乐\n\n歌词：\n[Verse]\n晚风", fields: { output_format: "url" } },
            { model, type: "lyria", input: { ...music, mode: "instrumental" }, content: "钢琴与弦乐\n\n纯音乐，不要人声。", fields: { output_format: "url" } },
        ]),
        { model: "suno-v6-mini", type: "suno", input: music, content: "钢琴与弦乐\n\n歌词：\n[Verse]\n晚风", fields: {} },
        { model: "suno-v6-mini", type: "suno", input: { ...music, mode: "instrumental" }, content: "钢琴与弦乐\n\n纯音乐，不要人声。", fields: { instrumental: true } },
    ];
    for (const entry of cases) {
        const format = entry.type === "gemini-tts" ? "wav" : entry.type === "lyria" ? "mp3" : "m4a";
        const id = await submit({ ...request(entry.type, entry.input), model: entry.model });
        response = completion([`https://tokenone.test/audio/${entry.model}-${entry.input.mode}.${format}?signature=keep&version=1`], entry.type);
        if (entry.type !== "suno") response.choices[0].message.content += `<audio src="data:audio/${format === "wav" ? "wav" : "mpeg"};base64,${(format === "wav" ? wavBytes : mp3Bytes).toString("base64")}"></audio>`;
        const calls = upstream.length;
        await executeMediaTask(id);
        const saved = await task(id);
        assert.equal(saved.status, "succeeded", `${entry.model}/${entry.input.mode}: ${saved.error}`);
        assert.equal(saved.result.audios.length, 1);
        assert.equal(saved.result.audios[0].file.format, format);
        assert.equal(saved.result.audios[0].file.mimeType, format === "wav" ? "audio/wav" : format === "mp3" ? "audio/mpeg" : "audio/mp4");
        assert.ok(saved.result.audios[0].file.durationMs > 0);
        assert.equal(upstream.length, calls + 1);
        assert.deepEqual(upstream.at(-1), { model: entry.model, messages: [{ role: "user", content: entry.content }], stream: false, ...entry.fields });
    }
});

test("audio permission accepts business inputs only and cannot open text endpoints", async () => {
    assert.equal((await call(`/ai/${channel}/v1/responses`, "POST", { model: "suno" })).status, 403);
    assert.equal((await call(`/ai/${channel}/v1/audio/speech`, "POST", { model: "suno" })).status, 403);
    assert.equal((await call(`/ai/${channel}/v1/chat/completions`, "POST", { ...request(), messages: [{ role: "user", content: "bypass" }] })).status, 400);
    assert.equal((await call(`/ai/${channel}/v1/chat/completions`, "POST", { ...request(), audio_type: "lyria" })).status, 400);
    assert.equal((await call("/admin/channels/audio", "PUT", { models: ["suno"], default_model: "suno", enabled: true }, admin)).status, 400);
});
test("concurrent identical submissions are accepted once and conflicting content is rejected", async () => {
    const body = request();
    const [first, second] = await Promise.all([submit(body), submit(body)]);
    assert.equal(first, second);
    assert.equal((await call(`/ai/${channel}/v1/chat/completions`, "POST", { ...body, title: "变更" })).status, 409);
    assert.equal((await (await call(`/audio/submissions/${body.submission_id}`)).json() as any).canvasTaskId, first);
    assert.equal((await call(`/audio/submissions/${body.submission_id}`, "GET", undefined, bob)).status, 404);
    response = completion(["https://tokenone.test/audio/a.m4a?sig=a&x=1", "https://tokenone.test/audio/b.m4a"]);
    const count = upstream.length;
    await Promise.all([executeMediaTask(first), executeMediaTask(first)]);
    const saved = await task(first);
    assert.equal(upstream.length, count + 1);
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.upstream_id, null);
    assert.equal(saved.result.audios.length, 2);
    assert.equal(saved.result.audios[0].file.format, "m4a");
    assert.ok(saved.result.audios[0].file.durationMs > 0);
    assert.ok(downloads.includes("https://tokenone.test/audio/a.m4a?sig=a&x=1"));
    assert.deepEqual(upstream.at(-1), { model: "suno", messages: [{ role: "user", content: "钢琴" }], stream: false });
    assert.equal(taskMedia(saved).length, 2);
    assert.equal((await call(`/tasks/${first}`, "GET", undefined, bob)).status, 404);
    assert.equal((await call(saved.result.audios[0].file.url.slice(4), "GET", undefined, bob)).status, 404);
    assert.ok(!(await (await call(`/tasks/${first}`)).text()).includes("sk-private"));
});
test("partial saves retain successful files and recovery never generates again or changes the default", async () => {
    const id = await submit(request());
    failUrl = "https://tokenone.test/audio/missing.m4a";
    response = completion([failUrl, "https://tokenone.test/audio/saved.m4a"]);
    await executeMediaTask(id);
    const partial = await task(id);
    assert.equal(partial.status, "unknown");
    assert.equal(partial.error, "AUDIO_SAVE_INCOMPLETE");
    assert.equal(partial.result.defaultIndex, 1);
    const original = partial.result.audios[1].file;
    const calls = upstream.length, reads = downloads.filter((url) => url.endsWith("/saved.m4a")).length;
    assert.equal((await call(`/tasks/${id}/resume-result`, "POST", {}, bob)).status, 409);
    assert.equal((await call(`/tasks/${id}/resume-result`, "POST", {})).status, 202);
    assert.equal((await task(id)).status, "pending");
    failUrl = "";
    await executeMediaTask(id);
    const complete = await task(id);
    assert.equal(complete.status, "succeeded");
    assert.equal(complete.result.defaultIndex, 1);
    assert.deepEqual(complete.result.audios[1].file, original);
    assert.equal(upstream.length, calls);
    assert.equal(downloads.filter((url) => url.endsWith("/saved.m4a")).length, reads);
});
test("unknown transport results stay unknown and cannot be automatically regenerated", async () => {
    const id = await submit(request()); transportFailure = true;
    try { await executeMediaTask(id); } finally { transportFailure = false; }
    assert.equal((await task(id)).status, "unknown");
    const count = upstream.length;
    await executeMediaTask(id);
    assert.equal(upstream.length, count);
    assert.equal((await call(`/tasks/${id}/resume-result`, "POST", {})).status, 409);
});
test("audio deadline stays unknown and never dispatches a replacement", async (context) => {
    const id = await submit(request());
    const timeout = AbortSignal.timeout;
    context.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds === AUDIO_REQUEST_TIMEOUT_MS ? AbortSignal.abort(new DOMException("Audio deadline exceeded", "TimeoutError")) : timeout(milliseconds));
    const calls = upstream.length;
    await executeMediaTask(id);
    const expired = await task(id);
    assert.equal(expired.status, "unknown");
    assert.equal(expired.error, "AUDIO_REQUEST_TIMEOUT");
    assert.equal(expired.upstream_result, null);
    await executeMediaTask(id);
    assert.equal(upstream.length, calls + 1);
    assert.equal((await call(`/tasks/${id}/resume-result`, "POST", {})).status, 409);
});
test("process interruption distinguishes saved response from unknown execution", async () => {
    const id = await submit(request());
    response = completion(["https://tokenone.test/audio/restart.m4a"]);
    await db.query("UPDATE generation_tasks SET status='running',execution_token=$2,upstream_result=$3 WHERE id=$1", [id, randomUUID(), JSON.stringify(response)]);
    const count = upstream.length;
    await executeMediaTask(id);
    assert.equal((await task(id)).status, "succeeded");
    assert.equal(upstream.length, count);
    const unknown = await submit(request());
    await db.query("UPDATE generation_tasks SET status='running',execution_token=$2 WHERE id=$1", [unknown, randomUUID()]);
    await executeMediaTask(unknown);
    assert.equal((await task(unknown)).status, "unknown");
    assert.equal(upstream.length, count);
});
test("complete responses with body errors and malformed audio never succeed", async () => {
    for (const type of ["gemini-tts", "lyria", "suno"]) {
        for (const entry of [
            { payload: { choices: [{ finish_reason: "stop", message: { content: "错误：失败" } }] }, status: "failed", error: "TOKENONE_GENERATION_FAILED" },
            { payload: { choices: [{ finish_reason: "length", message: { content: "" } }] }, status: "unknown", error: "INCOMPLETE_AUDIO_RESPONSE" },
            { payload: completion(["https://not-allowed.test/a.m4a"], type), status: "unknown", error: "AUDIO_SAVE_INCOMPLETE", fileError: "MEDIA_HOST_NOT_ALLOWED" },
            { payload: completion(["https://tokenone.test/audio/not-audio.html"], type), status: "unknown", error: "AUDIO_SAVE_INCOMPLETE", fileError: "INVALID_AUDIO_FILE" },
        ]) {
            const id = await submit(request(type, type === "gemini-tts" ? { ...structuredClone(defaultSpeechInput), text: "你好" } : { ...defaultMusicInput, description: "钢琴" }));
            response = entry.payload;
            await executeMediaTask(id);
            const saved = await task(id);
            assert.equal(saved.status, entry.status);
            assert.equal(saved.error, entry.error);
            if (entry.fileError) assert.equal(saved.result.audios[0].error, entry.fileError);
            const count = upstream.length;
            await executeMediaTask(id);
            assert.equal(upstream.length, count);
        }
    }
});
test("title edits preserve request snapshots, and favorites reuse owned files", async () => {
    const id = await submit(request()); response = completion(["https://tokenone.test/audio/favorite.m4a"]);
    await executeMediaTask(id);
    const previous = await task(id), file = previous.result.audios[0].file;
    assert.equal((await call(`/tasks/${id}`, "PATCH", { title: "跨设备名称" })).status, 200);
    assert.deepEqual((await task(id)).request, previous.request);
    assert.equal((await call(`/tasks/${id}`, "PATCH", { title: "越权" }, bob)).status, 404);
    const favorite = { kind: "audio", title: "独立收藏名称", coverUrl: "", tags: [], metadata: { taskId: id }, data: { ...file } };
    const saved = await call("/assets", "POST", favorite);
    assert.equal(saved.status, 201, await saved.clone().text());
    const asset = (await saved.json() as any).asset;
    assert.equal(asset.data.storageKey, file.storageKey);
    assert.equal((await call("/assets", "POST", favorite, bob)).status, 409);
    const works = await (await call("/works?view=works&kind=audio&audioCategory=music")).json() as any;
    assert.equal(works.works.find((work: any) => work.task?.id === id).task.title, "跨设备名称");
    assert.equal(works.works.find((work: any) => work.task?.id === id).assets[0].title, "独立收藏名称");
    assert.equal((await call(`/tasks/${id}`, "DELETE")).status, 200);
    assert.equal((await call(file.url.slice(4))).status, 200);
    const remaining = await (await call("/works?view=works&kind=audio&audioCategory=music&pageSize=100")).json() as any;
    assert.ok(remaining.works.some((work: any) => work.asset?.id === asset.id && work.source === "generated"));
});

async function canvasAudio() {
    const node = { id: "audio", type: "audio", title: "保留标题", position: { x: 10, y: 20 }, width: 340, height: 120, metadata: { prompt: "权威描述", model: `${channel}::suno`, audioInput: { ...defaultMusicInput, description: "权威描述" } } };
    const text = { ...node, id: "text", type: "text", metadata: { content: "连线文本" } };
    const image = { ...node, id: "image", type: "image", metadata: { prompt: "不要发送图片节点提示词" } };
    const created = await call("/projects", "POST", { title: "音频画布", nodes: [node, text, image], connections: [{ id: "text-edge", fromNodeId: "text", toNodeId: "audio" }, { id: "image-edge", fromNodeId: "image", toNodeId: "audio" }] });
    assert.equal(created.status, 201, await created.clone().text());
    const project = (await created.json() as any).project;
    const audio = project.nodes.find((item: any) => item.type === "audio");
    const generationId = randomUUID();
    const edit = await call(`/projects/${project.id}/commands`, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "put_node", node: { ...audio, metadata: { ...audio.metadata, generationId, status: "loading" } } }] } });
    assert.equal(edit.status, 200, await edit.clone().text());
    const body = { ...request(), submission_id: undefined, audio_input: { ...defaultMusicInput, description: "伪造正文" }, canvas_context: { projectId: project.id, nodeId: audio.id, generationId } };
    return { project: (await edit.json() as any).project, audio, body };
}
test("canvas creates authoritative text-only requests and keeps geometry and edited inputs", async () => {
    const { project, audio, body } = await canvasAudio();
    assert.equal((await call(`/ai/${channel}/v1/chat/completions`, "POST", body, bob)).status, 404);
    const id = await submit(body);
    assert.equal(await submit(body), id);
    const accepted = await task(id);
    assert.equal(accepted.request.audio_input.description, "权威描述");
    assert.equal(accepted.request.audio_context, "【文本 1】\n连线文本");
    assert.ok(!accepted.request.messages[0].content.includes("图片"));
    const current = (await (await call(`/projects/${project.id}`)).json() as any).project;
    const edited = { ...current.nodes.find((item: any) => item.id === audio.id), title: "编辑后的标题", position: { x: 50, y: 60 }, metadata: { ...current.nodes.find((item: any) => item.id === audio.id).metadata, prompt: "等待期间的新输入" } };
    assert.equal((await call(`/projects/${project.id}/commands`, "POST", { operationId: randomUUID(), baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "put_node", node: edited }] } })).status, 200);
    response = completion(["https://tokenone.test/audio/canvas-a.m4a", "https://tokenone.test/audio/canvas-b.m4a"]);
    await executeMediaTask(id);
    const final = (await (await call(`/projects/${project.id}`)).json() as any).project.nodes.find((item: any) => item.id === audio.id);
    assert.equal(final.title, "编辑后的标题");
    assert.deepEqual(final.position, { x: 50, y: 60 });
    assert.equal(final.metadata.prompt, "等待期间的新输入");
    assert.equal(final.metadata.content, (await task(id)).result.audios[0].file.url);
    assert.equal(taskMedia(await task(id)).length, 2);
});
test("late audio results do not resurrect deleted nodes or overwrite a new generation", async () => {
    for (const remove of [true, false]) {
        const { project, audio, body } = await canvasAudio();
        const id = await submit(body);
        const current = (await (await call(`/projects/${project.id}`)).json() as any).project;
        const next = { ...current.nodes.find((item: any) => item.id === audio.id), metadata: { ...audio.metadata, generationId: randomUUID(), status: "loading" } };
        assert.equal((await call(`/projects/${project.id}/commands`, "POST", { operationId: randomUUID(), baseRevision: current.contentRevision, baseGenerationRevision: current.generationRevision, command: { type: "edit_project", graphEdits: remove ? [{ type: "delete_node", id: audio.id }] : [{ type: "put_node", node: next }] } })).status, 200);
        response = completion(["https://tokenone.test/audio/late.m4a"]);
        await executeMediaTask(id);
        const saved = (await db.query("SELECT nodes FROM canvas_projects WHERE id=$1", [project.id])).rows[0].nodes.find((item: any) => (item.clientId || item.id) === audio.id);
        if (remove) assert.equal(saved, undefined); else { assert.equal(saved.metadata.generationId, next.metadata.generationId); assert.equal(saved.metadata.content, undefined); }
        assert.equal((await task(id)).status, "succeeded");
    }
});
test("uploaded audio uses the shared owned media path", async () => {
    const form = new FormData(); form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "上传.wav");
    const upload = await realFetch(`${base}/api/files/canvas-import`, { method: "POST", headers: { Cookie: `creativeone=${alice}`, Origin: "http://localhost:3001", "X-CSRF-Token": `csrf-${alice}` }, body: form });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    assert.equal((await call("/assets", "POST", { kind: "audio", title: "上传", coverUrl: "", tags: [], data: file })).status, 201);
    const all = await (await call("/works?view=works&kind=audio&audioCategory=all&pageSize=100")).json() as any;
    const music = await (await call("/works?view=works&kind=audio&audioCategory=music&pageSize=100")).json() as any;
    const speech = await (await call("/works?view=works&kind=audio&audioCategory=speech&pageSize=100")).json() as any;
    assert.ok(all.works.some((work: any) => work.asset?.title === "上传"));
    assert.ok(!music.works.some((work: any) => work.asset?.title === "上传"));
    assert.ok(speech.works.every((work: any) => work.task.request.audio_type === "gemini-tts"));
    const tasks = await (await call("/works?view=tasks&kind=audio&audioCategory=speech&pageSize=100")).json() as any;
    assert.ok(tasks.works.length > 0);
    assert.ok(tasks.works.every((work: any) => work.task.request.audio_type === "gemini-tts"));
    assert.ok(all.works.every((work: any) => work.state === "completed"));
});

test("admin tasks expose audio results and count audio tasks", async () => {
    const stats = await (await call(`/admin/tasks/stats?userId=${alice}`, "GET", undefined, admin)).json() as any;
    assert.ok(stats.stats[0].audios > 0);
    const list = await (await call(`/admin/tasks?capability=audio&userId=${alice}`, "GET", undefined, admin)).json() as any;
    assert.ok(list.total > 0);
    assert.ok(list.tasks.every((item: any) => item.capability === "audio"));
    const saved = (await db.query("SELECT id FROM generation_tasks WHERE user_id=$1 AND capability='audio' AND status='succeeded' ORDER BY created_at LIMIT 1", [alice])).rows[0];
    const detail = await (await call(`/admin/tasks/${saved.id}`, "GET", undefined, admin)).json() as any;
    assert.ok(detail.task.results.length > 0);
    assert.ok(detail.task.results.every((item: any) => item.kind === "audio"));
});


test("canvas audio can use connected text with an empty local prompt", async () => {
    const { project, audio, body } = await canvasAudio();
    const current = project.nodes.find((item: any) => item.id === audio.id);
    const updated = { ...current, metadata: { ...current.metadata, prompt: "", audioInput: { ...defaultMusicInput, description: "" } } };
    assert.equal((await call(`/projects/${project.id}/commands`, "POST", { operationId: randomUUID(), baseRevision: project.contentRevision, baseGenerationRevision: project.generationRevision, command: { type: "edit_project", graphEdits: [{ type: "put_node", node: updated }] } })).status, 200);
    const id = await submit({ ...body, audio_input: updated.metadata.audioInput });
    const saved = await task(id);
    assert.equal(saved.request.audio_input.description, "");
    assert.equal(saved.request.messages[0].content, "【文本 1】\n连线文本");
});
