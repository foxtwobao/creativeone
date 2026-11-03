import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { channelImageProfile } from "../../shared/image-models.js";
import { channelVideoProfile } from "../../shared/video-models.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test")) throw new Error("Provide an isolated *_test database");
Object.assign(process.env, { DATABASE_URL: database, APP_ORIGIN: "https://creative.test", IDONE_ISSUER: "https://idone.test", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "test", ENHANCER_BASE_URL: "https://reseller.test" });
const { db, initializeDatabase } = await import("./db.js");
const { attachModelProfiles } = await import("./model-profiles.js");
const { parameterPresetsMigrationId } = await import("./migrations/parameter-presets.js");
const snapshot = JSON.parse(await readFile(new URL("./migrations/parameter-presets-v1.json", import.meta.url), "utf8"));
const imageId = "00000000-0000-4000-8000-000000000001", videoId = "00000000-0000-4000-8000-000000000002";
const imageTypes: Record<string, string> = Object.fromEntries(Object.entries(snapshot.image).flatMap(([family, profiles]) => Object.keys(profiles as object).filter(Boolean).map(model => [model, family])));
imageTypes["banana2-1k"] = "openai";
Object.assign(imageTypes, { "team-openai": "openai", "team-banana": "banana", "team-grok": "grok", "workspace::gpt-image-2": "openai" });
const videoModels = Object.keys(snapshot.video).map((_, index) => `public-alias-${index}`);
const videoBindings = Object.fromEntries(Object.keys(snapshot.video).map((id, index) => [videoModels[index], id]));
const videoTypes = Object.fromEntries(Object.values(snapshot.video).map((preset: any, index) => [videoModels[index], preset.callType]));
let originalChannels: any[];
before(async () => {
    const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    // Reproduce the released database before any preset tables or image bindings existed.
    await db.query(schema.slice(0, schema.indexOf("CREATE TABLE IF NOT EXISTS video_parameter_presets")));
    await db.query("INSERT INTO channels(id,name,capability,models,image_types,enabled,model_descriptions) VALUES($1,'原图片配置','image',$2,$3,false,$4)", [imageId, JSON.stringify(Object.keys(imageTypes)), JSON.stringify(imageTypes), JSON.stringify({ "team-openai": "保留原描述" })]);
    await db.query("INSERT INTO channels(id,name,capability,models,video_types,video_presets,enabled) VALUES($1,'原视频配置','video',$2,$3,$4,true)", [videoId, JSON.stringify(videoModels), JSON.stringify(videoTypes), JSON.stringify(videoBindings)]);
    originalChannels = (await db.query("SELECT * FROM channels ORDER BY id")).rows;
});
after(async () => { await db.end(); });

test("startup migrates every released preset and old model binding without name guessing", async () => {
    await initializeDatabase();
    const channels = await attachModelProfiles((await db.query("SELECT * FROM channels ORDER BY id")).rows);
    const image = channels.find(c => c.id === imageId)!, video = channels.find(c => c.id === videoId)!;
    for (const [model, family] of Object.entries(imageTypes)) {
        const profiles = snapshot.image[family], name = model.split("::").pop()!, key = Object.hasOwn(profiles, name) ? name : "";
        assert.deepEqual(channelImageProfile(image, model), profiles[key].profile);
    }
    assert.equal(channelImageProfile(image, "banana2-1k").family, "openai");
    assert.equal(channelImageProfile(image, "banana2-1k").fixedResolution, undefined);
    for (const model of videoModels) {
        assert.equal(video.video_presets[model], videoBindings[model]);
        assert.deepEqual(channelVideoProfile(video, model), snapshot.video[videoBindings[model]].profile);
    }
    const wan = videoModels.find(model => videoBindings[model] === "wan3.0-video")!;
    assert.equal(channelVideoProfile(video, wan).ratios.includes("21:9"), false);
    assert.equal(channelVideoProfile(video, wan).maxVideos, null);
    const storedChannels = (await db.query("SELECT * FROM channels ORDER BY id")).rows;
    storedChannels.forEach((row, index) => {
        const { image_presets, ...rest } = row;
        assert.deepEqual(rest, originalChannels[index]);
        if (row.capability === "video") assert.deepEqual(image_presets, {});
    });
    const record = (await db.query("SELECT backup FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId])).rows[0];
    assert.equal(record.backup.source, snapshot.source);
    assert.deepEqual(record.backup.channels, originalChannels.map(row => ({ ...row, image_presets: {} })));
    assert.deepEqual(record.backup.imagePresets, []);
    assert.deepEqual(record.backup.videoPresets, []);
});

test("repeated and concurrent startup preserves administrator changes and deleted templates", async () => {
    await db.query("UPDATE image_parameter_presets SET profile=jsonb_set(profile,'{maxReferences}','3'),revision=9 WHERE id='gpt-image-2'");
    await db.query("UPDATE channels SET image_presets=jsonb_set(image_presets,'{team-openai}','\"gpt-image-2\"') WHERE id=$1", [imageId]);
    await db.query("DELETE FROM video_parameter_presets WHERE id='wan3-p'");
    const before = (await db.query("SELECT * FROM channels ORDER BY id")).rows;
    const migration = (await db.query("SELECT * FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId])).rows;
    await Promise.all([initializeDatabase(), initializeDatabase()]);
    assert.deepEqual((await db.query("SELECT * FROM channels ORDER BY id")).rows, before);
    assert.deepEqual((await db.query("SELECT * FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId])).rows, migration);
    const preset = (await db.query("SELECT profile,revision FROM image_parameter_presets WHERE id='gpt-image-2'")).rows[0];
    assert.equal(preset.profile.maxReferences, 3); assert.equal(preset.revision, 9);
    assert.equal((await db.query("SELECT 1 FROM video_parameter_presets WHERE id='wan3-p'")).rowCount, 0);
});

test("an occupied preset ID does not overwrite a changed database profile", async () => {
    await db.query("DELETE FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId]);
    await db.query("UPDATE channels SET image_presets=image_presets-'gpt-image-2' WHERE id=$1", [imageId]);
    await initializeDatabase();
    const channel = (await attachModelProfiles((await db.query("SELECT * FROM channels WHERE id=$1", [imageId])).rows))[0];
    assert.notEqual(channel.image_presets["gpt-image-2"], "gpt-image-2");
    assert.deepEqual(channelImageProfile(channel, "gpt-image-2"), snapshot.image.openai["gpt-image-2"].profile);
    assert.equal((await db.query("SELECT profile FROM image_parameter_presets WHERE id='gpt-image-2'")).rows[0].profile.maxReferences, 3);
    assert.equal(channel.image_presets["team-openai"], "gpt-image-2");
});

test("an unknown old video reference rolls back image inserts and binding updates together", async () => {
    await db.query("DELETE FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId]);
    await db.query("UPDATE image_parameter_presets SET profile=jsonb_set(profile,'{maxReferences}','2') WHERE id='banana-default'");
    await db.query("UPDATE channels SET image_presets=image_presets-'team-banana' WHERE id=$1", [imageId]);
    await db.query("UPDATE channels SET video_presets=jsonb_set(video_presets,ARRAY[$2],'\"unknown-old-preset\"') WHERE id=$1", [videoId, videoModels[0]]);
    const channels = (await db.query("SELECT * FROM channels ORDER BY id")).rows;
    const presets = (await db.query("SELECT * FROM image_parameter_presets ORDER BY id")).rows;
    await assert.rejects(initializeDatabase, /Cannot migrate video preset unknown-old-preset/);
    assert.deepEqual((await db.query("SELECT * FROM channels ORDER BY id")).rows, channels);
    assert.deepEqual((await db.query("SELECT * FROM image_parameter_presets ORDER BY id")).rows, presets);
    assert.equal((await db.query("SELECT 1 FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId])).rowCount, 0);
});
