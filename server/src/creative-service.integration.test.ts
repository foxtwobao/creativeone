import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile } from "mp4box";

const database = process.env.TEST_DATABASE_URL;
test("Public creation: user sessions, CSRF, durable replay and recovery", { skip: !database }, async () => {
    assert.ok(new URL(database!).pathname.endsWith("_test"), "Requires isolated *_test database");
    const media = await mkdtemp(join(tmpdir(), "creativeone-public-test-"));
    Object.assign(process.env, { DATABASE_URL: database, IDONE_DISCOVERY_URL: "", IDONE_ALLOW_HTTP: "false", APP_DOMAIN_SUFFIXES: "", APP_ORIGIN: "http://localhost:3001", APP_ORIGINS: '["http://localhost:3001"]', IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "admin", ENHANCER_BASE_URL: "https://enhancer.test", ENHANCER_APP_CREDENTIAL: "test", TOKENONE_BASE_URL: "https://tokenone.test", MEDIA_DIR: media });
    const { app } = await import("./index.js");
    const { db } = await import("./db.js");
    const { env, loginSites } = await import("./config.js");
    const { modelProvider } = await import("./tokenone.js");
    const { executeMediaTask } = await import("./generation-executor.js");
    const { audioDispatcher } = await import("./audio.js");
    const { saveFile } = await import("./storage.js");
    const alice = randomUUID(), bob = randomUUID(), channel = randomUUID(), imageChannel = randomUUID(), videoChannel = randomUUID();
    const nativeFetch = globalThis.fetch;
    let unavailable = false, keys = 0, posts = 0, loseResponse = true, keyDenied = false, videoQueryFailure = false, videoStatus = "failed";
    const wavBytes = await readFile(new URL("./fixtures/audio.wav", import.meta.url));
    const sharp = (await import("sharp")).default;
    const userinfoRequests: string[] = [];
    const generationRequests: { path: string; body: any }[] = [];
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === "https://idone.test/.well-known/openid-configuration") return Response.json({ issuer: "https://idone.test", authorization_endpoint: "https://idone.test/authorize", token_endpoint: "https://idone.test/token", userinfo_endpoint: "https://idone.test/userinfo", jwks_uri: "https://idone.test/jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
        if (url === "https://idone.test/userinfo") {
            const authorization = new Headers(init?.headers).get("Authorization") || "";
            assert.equal(new Headers(init?.headers).get("Cookie"), null);
            userinfoRequests.push(authorization);
            if (authorization === "Bearer unavailable") return Response.json({ status: "error" }, { status: 503 });
            if (authorization === "Bearer disconnected") throw new TypeError("identity provider unavailable");
            const subject = authorization === "Bearer idone-alice" || authorization === "Bearer wrong-issuer" ? alice : authorization === "Bearer idone-bob" ? bob : authorization === "Bearer unknown-user" ? "unknown-subject" : undefined;
            if (!subject) return Response.json({ status: "error", msg: "Access token doesn't exist or has expired" });
            // IDONE's audience identifies the issuing client, not CreativeOne's browser client.
            return Response.json({ iss: authorization === "Bearer wrong-issuer" ? "https://wrong.test" : "https://idone.test", aud: "botone-client", sub: subject });
        }
        if (url === "https://enhancer.test/api/apps/keys/ensure") { keys++; if (unavailable) return Response.json({ error: "APP_SERVICE_UNAVAILABLE" }, { status: 503 }); if (keyDenied) return Response.json({ error: "APP_USER_AUTHORIZATION_REQUIRED" }, { status: 403 }); return Response.json({ status: "ready", tokenone_user_id: "42", api_key: { id: "701", key: "test-user-key", group_id: "8", status: "active" } }); }
        if (url === "https://tokenone.test/v1/chat/completions") {
            posts++;
            if (loseResponse) throw new Error("response lost after dispatch");
            return Response.json({ choices: [{ finish_reason: "stop", message: { content: "[音频](https://tokenone.test/audio/one.wav)" } }], data: [{ url: "https://tokenone.test/audio/one.wav" }, { url: "https://tokenone.test/audio/two.wav" }] });
        }
        if (url.startsWith("https://tokenone.test/audio/")) return new Response(wavBytes, { headers: { "Content-Type": "audio/wav" } });
        if (url === "https://tokenone.test/v1/images/generations") {
            const request = JSON.parse(String(init?.body));
            generationRequests.push({ path: "images", body: request });
            return Response.json({ data: [{ b64_json: png.toString("base64") }] });
        }
        if (url === "https://tokenone.test/v1/images/edits") {
            const body = init?.body;
            if (body instanceof FormData) {
                assert.equal(new Headers(init?.headers).get("Content-Type"), null);
                const imageRefs = [...body.getAll("image"), ...body.getAll("image[]")];
                assert.ok(imageRefs.length);
                generationRequests.push({ path: "image-edits-form", body: { ...Object.fromEntries(body.entries()), imageRefs } });
            } else generationRequests.push({ path: "image-edits-json", body: JSON.parse(String(body)) });
            return Response.json({ data: [{ b64_json: png.toString("base64") }] });
        }
        if (url === "https://tokenone.test/v1/videos") {
            const request = JSON.parse(String(init?.body));
            generationRequests.push({ path: "videos", body: request });
            return Response.json({ id: "test-video", status: "queued" });
        }
        if (url === "https://tokenone.test/doubao/api/v3/contents/generations/tasks") {
            generationRequests.push({ path: "native-video", body: JSON.parse(String(init?.body)) });
            return Response.json({ id: "native-video", status: "queued" });
        }
        if (url === "https://tokenone.test/v1/videos/test-video") return videoQueryFailure ? Response.json({ error: { message: "query failed" } }, { status: 503 }) : Response.json({ id: "test-video", status: videoStatus });
        if (url === "https://tokenone.test/v1/videos/test-video/content") return new Response("not video", { headers: { "Content-Type": "text/html" } });
        return nativeFetch(input, init);
    };
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/integrations/v1`;
    loginSites.set(new URL(base).host, { origin: "http://localhost:3001" });
    const call = (path: string, method = "GET", body?: any, user = alice, csrfToken = `csrf-${user}`) => nativeFetch(base + path, {
        method, headers: { Cookie: `creativeone=${user}`, Origin: "http://localhost:3001", "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bearer = (path: string, method = "GET", body?: any, token = "idone-alice") => nativeFetch(base + path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
        for (const user of [alice, bob]) {
            await db.query("INSERT INTO users VALUES($1,'https://idone.test',$3,$2,true,$3,$3,'')", [user, `${user}@example.test`, user]);
            await db.query("INSERT INTO sessions(id_hash,user_id,csrf,expires_at,origin) VALUES($1,$2,$3,now()+interval '1 day','http://localhost:3001')", [createHash("sha256").update(user).digest("hex"), user, `csrf-${user}`]);
            await db.query("INSERT INTO key_bindings(user_id,provider,group_id,tokenone_user_id,key_id) VALUES($1,$2,'8','42','701')", [user, modelProvider]);
        }
        await db.query("INSERT INTO channels(id,name,capability,models,audio_types,enabled) VALUES($1,'music','audio',$2,$3,true)", [channel, JSON.stringify(["demo-music"]), JSON.stringify({ "demo-music": "suno" })]);
        await db.query("INSERT INTO channels(id,name,capability,models,image_types,image_presets,enabled) VALUES($1,'image','image',$2,$3,$4,true)", [imageChannel, '["demo-image"]', '{"demo-image":"openai"}', '{"demo-image":"openai-default"}']);
        await db.query("INSERT INTO channels(id,name,capability,models,video_types,video_presets,enabled) VALUES($1,'video','video',$2,$3,$4,true)", [videoChannel, '["demo-video"]', '{"demo-video":"tokenone"}', '{"demo-video":"wan3-standard"}']);
        await db.query("UPDATE channels SET model_descriptions=$2 WHERE id=$1", [channel, '{"demo-music":"音乐创作说明"}']);
        const catalogResponse = await call("/capabilities");
        assert.equal(catalogResponse.status, 200);
        assert.equal(keys, 0, "capabilities must not ensure a key");
        const catalog: any = await catalogResponse.json(), music = catalog.models.find((m: any) => m.kind === "music");
        assert.deepEqual(catalog.models.find((m: any) => m.kind === "video").presets[0].parameters, { resolution: "720P", ratio: "1:1", seconds: 6 });
        assert.equal(music.name, "demo-music");
        assert.equal(music.description, "音乐创作说明");
        assert.deepEqual(music.parameters.properties.mode.enum, ["song", "instrumental"]);
        const videoCapabilities = catalog.models.find((m: any) => m.kind === "video");
        assert.equal(videoCapabilities.name, "demo-video");
        assert.deepEqual(videoCapabilities.parameters.properties.resolution.enum, ["480P", "720P", "1080P"]);
        assert.equal(videoCapabilities.parameters.properties.seconds.minimum, 2);
        assert.equal(videoCapabilities.parameters.properties.seconds.maximum, 30);
        assert.equal(catalog.submission.presetOnly, false);
        assert.equal(catalog.submission.referenceMedia, true);
        assert.deepEqual(catalog.submission.referenceKinds, ["image", "video", "audio"]);
        assert.equal(catalog.submission.maxReferenceMediaBytes, 104857600);
        assert.equal(videoCapabilities.inputs.referenceVideos, true);
        assert.equal(videoCapabilities.inputs.referenceAudios, true);
        assert.equal(music.inputs.referenceAudios, false);
        assert.deepEqual(videoCapabilities.parameters.properties.mode.enum, ["frames", "reference"]);
        assert.equal(catalog.submission.maxReferenceImageBytes, 10485760);
        assert.equal(music.inputs.referenceImages, false);
        assert.equal(catalog.models.find((m: any) => m.kind === "image").inputs.referenceImages, true);
        assert.equal(music.defaultPreset, music.presets[0].id);
        assert.deepEqual(music.presets.map((p: any) => p.parameters.mode), ["song", "instrumental"]);
        const operation = randomUUID(), body = { kind: "music", model: music.id, preset: music.presets[1].id, prompt: "钢琴" };
        for (const token of ["expired", "forged", "refresh-token", "separate-id-token", "wrong-issuer"]) {
            const response = await bearer("/capabilities", "GET", undefined, token);
            assert.equal(response.status, 401, token);
            assert.equal((await response.json() as any).error.code, "authentication_required");
        }
        for (const token of ["unavailable", "disconnected"]) {
            const response = await bearer("/capabilities", "GET", undefined, token);
            assert.equal(response.status, 503);
            assert.equal((await response.json() as any).error.code, "authentication_unavailable");
        }
        assert.equal((await bearer("/capabilities", "GET", undefined, "unknown-user")).status, 403);
        assert.equal((await nativeFetch(base + "/capabilities", { headers: { Authorization: "Basic invalid", Cookie: `creativeone=${alice}` } })).status, 401, "bad Authorization cannot fall back to a valid Cookie");
        assert.equal((await bearer("/capabilities")).status, 200);
        assert.equal(keys, 0, "bearer capability reads do not ensure a key");
        const responses = await Promise.all([call(`/jobs/${operation}`, "PUT", body), bearer(`/jobs/${operation}`, "PUT", body)]);
        assert.deepEqual(responses.map(r => r.status), [202, 202]);
        const task = (await db.query("SELECT * FROM generation_tasks WHERE user_id=$1", [alice])).rows[0];
        assert.equal((await db.query("SELECT count(*) FROM generation_tasks WHERE user_id=$1", [alice])).rows[0].count, "1");
        assert.equal((await call(`/jobs/${operation}`, "PUT", { ...body, prompt: "不同正文" })).status, 409);
        assert.equal((await call(`/jobs/${operation}`, "GET", undefined, bob)).status, 404);
        assert.equal((await bearer(`/jobs/${operation}`, "GET", undefined, "idone-bob")).status, 404);
        assert.equal((await bearer(`/jobs/${operation}`)).status, 200);
        assert.equal((await call(`/jobs/${operation}`, "PUT", body, alice, "invalid-csrf")).status, 403);
        assert.equal((await call(`/jobs/${randomUUID()}`, "PUT", { ...body, parameters: { not_allowed: true } })).status, 422);
        assert.equal((await nativeFetch(base + "/capabilities")).status, 401);
        assert.equal((await (await nativeFetch(base + "/capabilities")).json() as any).error.code, "authentication_required");
        await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [alice]);
        assert.equal((await call(`/jobs/${operation}`)).status, 401);
        await db.query("UPDATE sessions SET expires_at=now()+interval '1 day' WHERE user_id=$1", [alice]);
        assert.equal((await call(`/jobs/${operation}`, "PUT", body)).status, 202);
        const secondSession = randomUUID();
        await db.query("INSERT INTO sessions(id_hash,user_id,csrf,expires_at,origin) VALUES($1,$2,$3,now()+interval '1 day','http://localhost:3001')", [createHash("sha256").update(secondSession).digest("hex"), alice, `csrf-${alice}`]);
        assert.equal((await call(`/jobs/${operation}`, "PUT", body, secondSession, `csrf-${alice}`)).status, 202, "another login by the same user reuses the task");
        assert.equal((await call(`/jobs/${operation}`, "PUT", body, bob)).status, 202, "operation IDs belong to users, not callers");
        const beforeReplayKeys = keys;
        await db.query("UPDATE channels SET audio_types=$2 WHERE id=$1", [channel, '{"demo-music":"lyria"}']);
        const changed: any = await (await call("/capabilities")).json();
        assert.notEqual(changed.models.find((m: any) => m.kind === "music").defaultPreset, music.defaultPreset);
        assert.equal((await call(`/jobs/${operation}`, "PUT", body)).status, 202);
        assert.equal(keys, beforeReplayKeys, "replay does not ensure a new key");
        await db.query("UPDATE video_parameter_presets SET profile=jsonb_set(profile,'{duration,max}','20') WHERE id='wan3-standard'");
        const updatedCatalog: any = await (await call("/capabilities")).json();
        assert.equal(updatedCatalog.models.find((m: any) => m.kind === "video").parameters.properties.seconds.maximum, 20);
        assert.equal(updatedCatalog.models.find((m: any) => m.kind === "video").defaultPreset, videoCapabilities.defaultPreset, "a non-default range change does not change the default request identity");
        assert.equal((await call(`/jobs/${randomUUID()}`, "PUT", body)).status, 422);
        await db.query("UPDATE channels SET audio_types=$2 WHERE id=$1", [channel, '{"demo-music":"suno"}']);
        unavailable = true;
        assert.equal((await call(`/jobs/${operation}`)).status, 200);
        await executeMediaTask(task.id);
        assert.equal(posts, 0);
        assert.equal((await db.query("SELECT status FROM generation_tasks WHERE id=$1", [task.id])).rows[0].status, "pending");
        unavailable = false;
        await Promise.all([executeMediaTask(task.id), executeMediaTask(task.id)]);
        assert.equal(posts, 1);
        assert.equal((await db.query("SELECT status FROM generation_tasks WHERE id=$1", [task.id])).rows[0].status, "unknown");
        await executeMediaTask(task.id);
        assert.equal(posts, 1, "unknown never resends");
        // Recover a crash after the durable marker, even when no HTTP request was made.
        await db.query("UPDATE generation_tasks SET status='running',execution_token=$2 WHERE id=$1", [task.id, randomUUID()]);
        await executeMediaTask(task.id);
        assert.equal(posts, 1);
        // A crash before the sending marker must stay recoverable.
        await db.query("UPDATE generation_tasks SET integration_sent=false,status='running',execution_token=$2 WHERE id=$1", [task.id, randomUUID()]);
        unavailable = true;
        await executeMediaTask(task.id);
        assert.equal((await db.query("SELECT status FROM generation_tasks WHERE id=$1", [task.id])).rows[0].status, "pending");
        unavailable = false;
        keyDenied = true;
        await executeMediaTask(task.id);
        assert.equal(posts, 1, "revoked billing authorization cannot dispatch");
        assert.equal((await (await call(`/jobs/${operation}`)).json() as any).errorCode, "authorization_required");
        keyDenied = false;
        const wav = await readFile(new URL("./fixtures/audio.wav", import.meta.url));
        const url = await saveFile(alice, "media_files", "bot-output", wav, "audio/wav");
        await db.query("UPDATE generation_tasks SET status='succeeded',result=$2 WHERE id=$1", [task.id, JSON.stringify({ audios: [{ file: { url } }] })]);
        const ready: any = await (await call(`/jobs/${operation}`)).json();
        assert.equal(ready.status, "succeeded");
        assert.equal(ready.outputs[0].mimeType, "audio/wav");
        const download = await call(`/jobs/${operation}/outputs/${ready.outputs[0].id}`);
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), wav);
        assert.equal((await call(`/jobs/${operation}/outputs/${ready.outputs[0].id}`, "GET", undefined, bob)).status, 404);
        assert.equal((await bearer(`/jobs/${operation}/outputs/${ready.outputs[0].id}`, "GET", undefined, "idone-bob")).status, 404);
        assert.equal((await bearer(`/jobs/${operation}/outputs/${ready.outputs[0].id}`)).status, 200);
        assert.ok(userinfoRequests.filter(value => value === "Bearer idone-alice").length > 3, "access tokens are verified on every public API call");
        assert.equal((await call(`/jobs/${randomUUID()}/outputs/${ready.outputs[0].id}`)).status, 404);
        await db.query("UPDATE files SET delete_requested=true WHERE user_id=$1", [alice]);
        assert.equal((await call(`/jobs/${operation}/outputs/${ready.outputs[0].id}`)).status, 404);
        assert.equal((await (await call(`/jobs/${operation}`)).json() as any).errorCode, "output_unavailable");
        await db.query("UPDATE generation_tasks SET hidden_from_works=true WHERE id=$1", [task.id]);
        assert.equal((await call(`/jobs/${operation}`, "PUT", body)).status, 404);
        assert.equal(posts, 1);
        loseResponse = false;
        // Exercise the actual shared executors for both music modes and image/video submission.
        for (const mode of ["song", "instrumental"]) {
            const op = randomUUID();
            const preset = music.presets.find((p: any) => p.parameters.mode === mode);
            assert.equal((await call(`/jobs/${op}`, "PUT", { ...body, preset: preset.id })).status, 202);
            const row = (await db.query("SELECT id FROM generation_tasks WHERE integration_operation=$1", [op])).rows[0];
            await executeMediaTask(row.id);
            const result: any = await (await call(`/jobs/${op}`)).json();
            assert.equal(result.status, "succeeded");
            assert.equal(result.outputs.length, 2);
            assert.ok(result.outputs.every((f: any) => f.mimeType === "audio/wav"));
        }
        for (const kind of ["image", "video"]) {
            const model = catalog.models.find((m: any) => m.kind === kind);
            assert.ok(model, `${kind} must advertise a valid text-only default`);
            const op = randomUUID();
            assert.equal((await call(`/jobs/${op}`, "PUT", { kind, model: model.id, preset: model.defaultPreset, prompt: "风景" })).status, 202);
            const row = (await db.query("SELECT id FROM generation_tasks WHERE integration_operation=$1", [op])).rows[0];
            await executeMediaTask(row.id);
            const result: any = await (await call(`/jobs/${op}`)).json();
            assert.equal(result.status, kind === "image" ? "succeeded" : "running");
            if (kind === "image") assert.equal(result.outputs[0].mimeType, "image/png");
            else {
                const { processVideoTask } = await import("./video-tasks.js");
                await processVideoTask(row.id);
                assert.equal((await (await call(`/jobs/${op}`)).json() as any).status, "failed");
                // A known task ID is not an output-save failure when querying stops.
                await db.query("UPDATE generation_tasks SET status='pending',upstream_error=$2 WHERE id=$1", [row.id, JSON.stringify({ queryFailures: 3 })]);
                videoQueryFailure = true;
                await processVideoTask(row.id);
                const queryFailed: any = await (await call(`/jobs/${op}`)).json();
                assert.equal(queryFailed.status, "unknown");
                assert.equal(queryFailed.errorCode, "task_query_failed");
                videoQueryFailure = false;
                await db.query("UPDATE generation_tasks SET status='pending',error=NULL,upstream_error=NULL WHERE id=$1", [row.id]);
                keyDenied = true;
                await processVideoTask(row.id);
                assert.equal((await (await call(`/jobs/${op}`)).json() as any).errorCode, "authorization_required");
                keyDenied = false;
                await db.query("UPDATE generation_tasks SET status='pending',error=NULL,upstream_error=NULL WHERE id=$1", [row.id]);
                videoStatus = "completed";
                await processVideoTask(row.id);
                assert.equal((await (await call(`/jobs/${op}`)).json() as any).errorCode, "output_incomplete");
            }
        }
        // Additional configured aliases exercise non-default request fields, not model-name inference.
        await db.query("UPDATE channels SET models=$2,image_types=$3,image_presets=$4 WHERE id=$1", [imageChannel, '["demo-image","demo-grok","demo-banana"]', '{"demo-image":"openai","demo-grok":"grok","demo-banana":"banana"}', '{"demo-image":"openai-default","demo-grok":"grok-imagine-image-2.0","demo-banana":"banana2-1k"}']);
        await db.query("UPDATE channels SET models=$2,video_types=$3,video_presets=$4 WHERE id=$1", [videoChannel, '["demo-video","demo-h3","demo-veo","demo-native"]', '{"demo-video":"tokenone","demo-h3":"tokenone","demo-veo":"tokenone","demo-native":"seedance"}', '{"demo-video":"wan3-standard","demo-h3":"MiniMax-H3","demo-veo":"veo-3.1-fast","demo-native":"doubao-seedance-2-5-260628"}']);
        const options: any = await (await bearer("/capabilities")).json();
        const makeInput = (name: string, parameters: any) => {
            const model = options.models.find((m: any) => m.name === name);
            assert.ok(model, name);
            return { kind: model.kind, model: model.id, prompt: "按所选参数创作", parameters };
        };
        const generate = async (input: any) => {
            const operationId = randomUUID();
            const accepted = await bearer(`/jobs/${operationId}`, "PUT", input);
            assert.equal(accepted.status, 202, await accepted.clone().text());
            const row = (await db.query("SELECT * FROM generation_tasks WHERE user_id=$1 AND integration_operation=$2", [alice, operationId])).rows[0];
            const sentBefore = generationRequests.length;
            await executeMediaTask(row.id);
            assert.equal(generationRequests.length, sentBefore + 1, JSON.stringify(input));
            return { operationId, row, sent: generationRequests.at(-1)!.body };
        };
        const videoInput = makeInput("demo-video", { resolution: "1080P", ratio: "16:9", seconds: 10, seed: 42 });
        const videoRun = await generate(videoInput);
        assert.equal(videoRun.sent.resolution, "1080P");
        assert.equal(videoRun.sent.ratio, "16:9");
        assert.equal(videoRun.sent.duration, 10);
        assert.equal(videoRun.sent.metadata.parameters.seed, 42);
        assert.equal((await bearer(`/jobs/${videoRun.operationId}`, "PUT", { ...videoInput, parameters: { seed: 42, seconds: 10, ratio: "16:9", resolution: "1080P" } })).status, 202);
        assert.equal((await bearer(`/jobs/${videoRun.operationId}`, "PUT", { ...videoInput, parameters: { ...videoInput.parameters, seconds: 11 } })).status, 409);
        const defaultVideoInput = makeInput("demo-video", {});
        const defaultVideoRun = await generate(defaultVideoInput);
        assert.equal((await bearer(`/jobs/${defaultVideoRun.operationId}`, "PUT", { ...defaultVideoInput, parameters: { resolution: "720P", ratio: "1:1", seconds: 6 } })).status, 202);
        const musicOverrideInput = makeInput("demo-music", { mode: "instrumental" });
        const musicOverrideId = randomUUID();
        assert.equal((await bearer(`/jobs/${musicOverrideId}`, "PUT", musicOverrideInput)).status, 202);
        const musicOverrideTask = (await db.query("SELECT * FROM generation_tasks WHERE user_id=$1 AND integration_operation=$2", [alice, musicOverrideId])).rows[0];
        assert.equal(musicOverrideTask.request.audio_input.mode, "instrumental");
        await executeMediaTask(musicOverrideTask.id);
        assert.equal((await (await bearer(`/jobs/${musicOverrideId}`)).json() as any).status, "succeeded");
        const imageInput = makeInput("demo-image", { size: "2048x2048", quality: "high", background: "transparent" });
        const imageRun = await generate(imageInput);
        assert.equal(imageRun.sent.size, "2048x2048");
        assert.equal(imageRun.sent.quality, "high");
        assert.equal(imageRun.sent.background, "transparent");
        const ratioInput = makeInput("demo-image", { size: "2:3" });
        const ratioRun = await generate(ratioInput);
        assert.equal(ratioRun.sent.size, "1024x1536");
        assert.equal((await bearer(`/jobs/${ratioRun.operationId}`, "PUT", { ...ratioInput, parameters: { size: "1024x1536", quality: "auto" } })).status, 200);
        const grokRun = await generate(makeInput("demo-grok", { aspect_ratio: "16:9", resolution: "2k", quality: "medium" }));
        assert.equal(grokRun.sent.aspect_ratio, "16:9");
        assert.equal(grokRun.sent.resolution, "2k");
        assert.equal(grokRun.sent.quality, "medium");
        assert.equal((await generate(makeInput("demo-banana", { size: "16:9" }))).sent.size, "16:9");
        const h3Run = await generate(makeInput("demo-h3", { resolution: "2K", seconds: 15, fastMode: true }));
        assert.equal(h3Run.sent.resolution, "2K");
        assert.equal(h3Run.sent.duration, 15);
        assert.equal(h3Run.sent.metadata.parameters.fast_mode, true);
        const nativeRun = await generate(makeInput("demo-native", { resolution: "1080p", ratio: "adaptive", seconds: -1, generateAudio: false, watermark: true }));
        assert.equal(nativeRun.sent.resolution, "1080p");
        assert.equal(nativeRun.sent.duration, undefined);
        assert.equal(nativeRun.sent.generate_audio, false);
        assert.equal(nativeRun.sent.watermark, true);
        const beforeInvalidKeys = keys, beforeInvalidPosts = generationRequests.length;
        for (const invalid of [
            makeInput("demo-video", { resolution: "4K" }), makeInput("demo-video", { seconds: 21 }),
            makeInput("demo-video", { seconds: "10" }), makeInput("demo-video", { generateAudio: true }),
            makeInput("demo-h3", { resolution: "2K", seconds: 16 }), makeInput("demo-veo", { seconds: 6 }),
            makeInput("demo-banana", { resolution: "2k" }), makeInput("demo-image", { size: "15x15" }),
            makeInput("demo-image", { quality: "unknown" }), makeInput("demo-image", { url: "https://untrusted.test" }),
        ]) {
            assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", invalid)).status, 422, JSON.stringify(invalid.parameters));
        }
        assert.equal(keys, beforeInvalidKeys, "invalid combinations are rejected before ensureKey");
        assert.equal(generationRequests.length, beforeInvalidPosts);
        const upload = (bytes: Buffer, token = "idone-alice") => nativeFetch(base + "/references", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" }, body: bytes });
        const uploaded = await upload(png);
        assert.equal(uploaded.status, 201);
        const reference: any = await uploaded.json();
        assert.equal(reference.mimeType, "image/png");
        assert.equal(reference.width, 2);
        assert.equal(reference.height, 2);
        assert.equal((await (await upload(png)).json() as any).id, reference.id, "retrying an identical upload keeps the same immutable reference");
        assert.equal((await db.query("SELECT count(*) FROM files WHERE user_id=$1 AND key LIKE 'image:creative-reference:%'", [alice])).rows[0].count, "1");
        const bananaInput = { ...makeInput("demo-banana", { size: "16:9" }), references: [reference.id] };
        const bananaReferenceRun = await generate(bananaInput);
        assert.match(bananaReferenceRun.sent.images[0], /^data:image\/png;base64,/);
        assert.match(bananaReferenceRun.sent.prompt, /参考图片编号/);
        assert.equal(bananaReferenceRun.sent.user_prompt, undefined);
        const bananaOutput: any = await (await bearer(`/jobs/${bananaReferenceRun.operationId}`)).json();
        assert.equal((await bearer(`/references/${bananaOutput.outputs[0].id}`, "DELETE")).status, 404, "reference cleanup cannot delete a generated work");
        const beforeReferenceReplay = generationRequests.length;
        assert.equal((await bearer(`/jobs/${bananaReferenceRun.operationId}`, "PUT", bananaInput)).status, 200);
        assert.equal(generationRequests.length, beforeReferenceReplay);
        const openaiReferenceRun = await generate({ ...makeInput("demo-image", { size: "1024x1024" }), references: [reference.id] });
        assert.equal(openaiReferenceRun.sent.imageRefs[0].type, "image/png");
        assert.deepEqual(Buffer.from(await openaiReferenceRun.sent.imageRefs[0].arrayBuffer()), png);
        const frozenTypeId = randomUUID();
        const frozenTypeInput = { ...makeInput("demo-image", {}), references: [reference.id] };
        assert.equal((await bearer(`/jobs/${frozenTypeId}`, "PUT", frozenTypeInput)).status, 202);
        const frozenTypeTask = (await db.query("SELECT id FROM generation_tasks WHERE user_id=$1 AND integration_operation=$2", [alice, frozenTypeId])).rows[0];
        await db.query("UPDATE channels SET image_types=jsonb_set(image_types,'{demo-image}', $2::jsonb) WHERE id=$1", [imageChannel, JSON.stringify("banana")]);
        await executeMediaTask(frozenTypeTask.id);
        assert.equal(generationRequests.at(-1)!.path, "image-edits-form", "accepted protocol is immutable when current configuration changes");
        await db.query("UPDATE channels SET image_types=jsonb_set(image_types,'{demo-image}', $2::jsonb) WHERE id=$1", [imageChannel, JSON.stringify("openai")]);
        const grokReferenceRun = await generate({ ...makeInput("demo-grok", { resolution: "2k" }), references: [reference.id] });
        assert.equal(grokReferenceRun.sent.aspect_ratio, undefined, "single-reference Grok uses the original image ratio");
        assert.equal(grokReferenceRun.sent.resolution, "2k");
        assert.match(grokReferenceRun.sent.image.url, /^data:image\/png;base64,/);
        const jpeg = await sharp(png).jpeg().toBuffer();
        const secondReference: any = await (await upload(jpeg)).json();
        assert.equal(secondReference.mimeType, "image/jpeg", "detect MIME from bytes, not the request header");
        const multiple = await generate({ ...makeInput("demo-image", {}), references: [reference.id, secondReference.id] });
        assert.equal(multiple.sent.imageRefs.length, 2);
        assert.equal((await bearer(`/jobs/${multiple.operationId}`, "PUT", { ...makeInput("demo-image", {}), references: [secondReference.id, reference.id] })).status, 409);
        assert.equal((await bearer(`/jobs/${bananaReferenceRun.operationId}`, "PUT", { ...bananaInput, references: [secondReference.id] })).status, 409);
        const referenceKeys = keys;
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", { ...bananaInput }, "idone-bob")).status, 404);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", { ...bananaInput, references: [randomUUID()] })).status, 404);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", { ...makeInput("demo-grok", { aspect_ratio: "16:9" }), references: [reference.id] })).status, 422);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", { ...makeInput("demo-grok", {}), references: Array(6).fill(reference.id) })).status, 422);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", { ...makeInput("demo-music", {}), references: [reference.id] })).status, 422);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", { ...bananaInput, references: ["https://untrusted.test/photo.png"] })).status, 422);
        assert.equal(keys, referenceKeys, "reference validation happens before ensureKey");
        assert.equal((await upload(Buffer.from("not an image"))).status, 415);
        const tooLarge = await upload(Buffer.concat([png, Buffer.alloc(10485761 - png.length)]));
        assert.equal(tooLarge.status, 413);
        assert.equal((await tooLarge.json() as any).error.code, "reference_image_too_large");
        assert.equal((await upload(png, "forged")).status, 401);
        assert.equal((await bearer(`/references/${reference.id}`, "DELETE", undefined, "idone-bob")).status, 404);
        // Deleting a reference prevents new use but must not remove an accepted task's input.
        const acceptedReferenceId = randomUUID();
        assert.equal((await bearer(`/jobs/${acceptedReferenceId}`, "PUT", bananaInput)).status, 202);
        const acceptedReferenceTask = (await db.query("SELECT id FROM generation_tasks WHERE user_id=$1 AND integration_operation=$2", [alice, acceptedReferenceId])).rows[0];
        assert.equal((await bearer(`/references/${reference.id}`, "DELETE")).status, 204);
        assert.equal((await bearer(`/jobs/${acceptedReferenceId}`, "PUT", bananaInput)).status, 202);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", bananaInput)).status, 404);
        await executeMediaTask(acceptedReferenceTask.id);
        assert.equal((await (await bearer(`/jobs/${acceptedReferenceId}`)).json() as any).status, "succeeded");
        assert.equal((await bearer(`/jobs/${bananaReferenceRun.operationId}`, "PUT", bananaInput)).status, 200);
        assert.equal((await (await upload(png)).json() as any).id, reference.id);
        const unusedBytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "blue" } }).png().toBuffer();
        const unused: any = await (await upload(unusedBytes)).json();
        assert.equal((await bearer(`/references/${unused.id}`, "DELETE")).status, 204);
        assert.equal((await db.query("SELECT count(*) FROM files WHERE user_id=$1 AND disk_id=$2", [alice, unused.id])).rows[0].count, "0");
        // Upload video/audio through the same authenticated binary endpoint and exercise both video protocols.
        const fixture = createFile();
        fixture.addTrack({ type: "avc1", width: 960, height: 540, timescale: 1000, media_duration: 4000, duration: 4000 });
        const videoBytes = Buffer.from(fixture.getBuffer().buffer);
        const videoUpload = await upload(videoBytes); // The image header must not override detected bytes.
        assert.equal(videoUpload.status, 201);
        const videoRef: any = await videoUpload.json();
        assert.equal(videoRef.kind, "video");
        assert.equal(videoRef.mimeType, "video/mp4");
        assert.equal(videoRef.durationMs, 4000);
        assert.equal(videoRef.width, 960);
        assert.equal((await (await upload(videoBytes)).json() as any).id, videoRef.id);
        const audioUpload = await upload(wavBytes);
        assert.equal(audioUpload.status, 201);
        const audioRef: any = await audioUpload.json();
        assert.equal(audioRef.kind, "audio");
        assert.equal(audioRef.mimeType, "audio/wav");
        assert.ok(audioRef.durationMs > 0);
        const m4aUpload = await upload(await readFile(new URL("./fixtures/audio-opus.mp4", import.meta.url)));
        assert.equal(m4aUpload.status, 201);
        assert.equal((await m4aUpload.json() as any).kind, "audio", "audio-only MP4 is not advertised as video");
        const origin = env.APP_ORIGIN;
        env.APP_ORIGIN = "https://creative.test";
        try {
            const mixedInput = { ...makeInput("demo-video", { mode: "reference" }), references: [reference.id, videoRef.id, audioRef.id] };
            const mixed = await generate(mixedInput);
            assert.equal(generationRequests.at(-1)!.path, "videos");
            const mediaRefs = mixed.sent.metadata.input.media;
            assert.deepEqual(mediaRefs.map((ref: any) => ref.type), ["reference_image", "reference_video", "reference_audio"]);
            for (const [index, id, bytes] of [[0, reference.id, png], [1, videoRef.id, videoBytes], [2, audioRef.id, wavBytes]] as const) {
                const signed = new URL(mediaRefs[index].url);
                assert.equal(signed.origin, env.APP_ORIGIN);
                assert.equal(signed.pathname, `/api/public/media/${id}`);
                const read = await nativeFetch(new URL(signed.pathname + signed.search, base));
                assert.equal(read.status, 200);
                assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
                signed.searchParams.set("signature", "0".repeat(64));
                assert.equal((await nativeFetch(new URL(signed.pathname + signed.search, base))).status, 403);
            }
            const count = generationRequests.length;
            assert.equal((await bearer(`/jobs/${mixed.operationId}`, "PUT", mixedInput)).status, 202);
            assert.equal(generationRequests.length, count);
            assert.equal((await bearer(`/jobs/${mixed.operationId}`, "PUT", { ...mixedInput, references: [...mixedInput.references].reverse() })).status, 409);
            const nativeRefs = await generate({ ...makeInput("demo-native", {}), references: [reference.id, videoRef.id, audioRef.id] });
            assert.equal(generationRequests.at(-1)!.path, "native-video");
            assert.equal(nativeRefs.sent.omni_reference_task_type, "reference");
            assert.match(nativeRefs.sent.content[1].image_url.url, /^data:image\/png;base64,/);
            assert.match(nativeRefs.sent.content[2].video_url.url, /^https:\/\/creative.test\/api\/public\/media\//);
            assert.match(nativeRefs.sent.content[3].audio_url.url, /^https:\/\/creative.test\/api\/public\/media\//);
            const h3Refs = await generate({ ...makeInput("demo-h3", {}), references: [videoRef.id, audioRef.id] });
            assert.deepEqual(h3Refs.sent.metadata.input.media.map((ref: any) => ref.type), ["reference_video", "reference_audio"]);
            const audioOnly = await generate({ ...makeInput("demo-video", {}), references: [audioRef.id] });
            assert.equal(audioOnly.sent.metadata.input.media[0].type, "reference_audio");
            const imageFrames = await generate({ ...makeInput("demo-video", { mode: "frames" }), references: [reference.id, secondReference.id] });
            assert.deepEqual(imageFrames.sent.metadata.input.media.map((ref: any) => ref.type), ["first_frame", "last_frame"]);
            const beforeRejectKeys = keys, beforeRejectPosts = generationRequests.length;
            for (const input of [
                { ...makeInput("demo-banana", {}), references: [videoRef.id] },
                { ...makeInput("demo-music", {}), references: [audioRef.id] },
                { ...makeInput("demo-veo", {}), references: [videoRef.id] },
                { ...makeInput("demo-veo", {}), references: [audioRef.id] },
                { ...makeInput("demo-video", { mode: "frames" }), references: [reference.id, videoRef.id] },
                { ...makeInput("demo-h3", { mode: "frames" }), references: [audioRef.id] },
                { ...makeInput("demo-h3", { mode: "reference" }), references: Array(4).fill(videoRef.id) },
                { ...makeInput("demo-native", {}), references: Array(8).fill(videoRef.id) }, // 32s > existing 30s aggregate duration.
                { ...makeInput("demo-video", { mode: "invalid" }), references: [videoRef.id] },
            ]) assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", input)).status, 422, JSON.stringify(input));
            assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", mixedInput, "idone-bob")).status, 404);
            assert.equal((await bearer(`/references/${audioRef.id}`, "DELETE", undefined, "idone-bob")).status, 404);
            assert.equal(keys, beforeRejectKeys);
            assert.equal(generationRequests.length, beforeRejectPosts);
            const acceptedId = randomUUID();
            assert.equal((await bearer(`/jobs/${acceptedId}`, "PUT", mixedInput)).status, 202);
            const acceptedTask = (await db.query("SELECT id FROM generation_tasks WHERE user_id=$1 AND integration_operation=$2", [alice, acceptedId])).rows[0];
            assert.equal((await bearer(`/references/${videoRef.id}`, "DELETE")).status, 204);
            assert.equal((await bearer(`/references/${audioRef.id}`, "DELETE")).status, 204);
            assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", mixedInput)).status, 404);
            assert.equal((await bearer(`/jobs/${acceptedId}`, "PUT", mixedInput)).status, 202);
            await executeMediaTask(acceptedTask.id);
            assert.equal(generationRequests.at(-1)!.path, "videos", "accepted media remain readable after cleanup");
            assert.equal((await (await upload(videoBytes)).json() as any).id, videoRef.id);
            assert.equal((await (await upload(wavBytes)).json() as any).id, audioRef.id);
        } finally { env.APP_ORIGIN = origin; }
        const beforeRulesChangeKeys = keys;
        // Replays use accepted rules, even when current settings would reject these parameters.
        await db.query("UPDATE image_parameter_presets SET profile=jsonb_set(profile,'{pixelBounds,maxEdge}','1024') WHERE id='openai-default'");
        assert.equal((await bearer(`/jobs/${imageRun.operationId}`, "PUT", imageInput)).status, 200);
        assert.equal((await bearer(`/jobs/${randomUUID()}`, "PUT", imageInput)).status, 422);
        assert.equal(keys, beforeRulesChangeKeys);
    } finally {
        globalThis.fetch = nativeFetch;
        await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
        await db.query("DELETE FROM generation_tasks WHERE user_id=ANY($1::uuid[])", [[alice, bob]]);
        await db.query("DELETE FROM files WHERE user_id=ANY($1::uuid[])", [[alice, bob]]);
        await db.query("DELETE FROM key_bindings WHERE user_id=ANY($1::uuid[])", [[alice, bob]]);
        await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [[alice, bob]]);
        await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[alice, bob]]);
        await db.query("DELETE FROM channels WHERE id=ANY($1::uuid[])", [[channel, imageChannel, videoChannel]]);
        await db.end();
        await audioDispatcher.close();
        await rm(media, { recursive: true, force: true });
    }
});
