import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import type { ImageProfile } from "../../../shared/image-models.js";
import type { VideoProfile, VideoCallType } from "../../../shared/video-models.js";

type Preset<P> = { label: string; profile: P };
type LegacyPresets = {
    source: string;
    image: Record<string, Record<string, Preset<ImageProfile>>>;
    video: Record<string, Preset<VideoProfile> & { callType: VideoCallType }>;
};
export const parameterPresetsMigrationId = "parameter-presets-v1";

// Called only inside the startup schema transaction; never used to resolve runtime requests.
export async function migrateParameterPresets(client: Pick<PoolClient, "query">) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('creativeone-parameter-presets-v1'))");
    if ((await client.query("SELECT 1 FROM app_data_migrations WHERE id=$1", [parameterPresetsMigrationId])).rowCount) return;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('creativeone-image-presets'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('creativeone-video-presets'))");
    const snapshot: LegacyPresets = JSON.parse(await readFile(new URL("./parameter-presets-v1.json", import.meta.url), "utf8"));
    const channels = (await client.query("SELECT * FROM channels ORDER BY id FOR UPDATE")).rows;
    const images = (await client.query("SELECT * FROM image_parameter_presets ORDER BY id")).rows;
    const videos = (await client.query("SELECT * FROM video_parameter_presets ORDER BY id")).rows;
    const backup = { source: snapshot.source, channels, imagePresets: images, videoPresets: videos };
    const imagePresets = new Map(images.map(p => [p.id, p]));
    const videoPresets = new Map(videos.map(p => [p.id, p]));
    const ensurePreset = async (kind: "image" | "video", id: string, preset: Preset<ImageProfile | VideoProfile>) => {
        const presets = kind === "image" ? imagePresets : videoPresets;
        if (presets.has(id) && !isDeepStrictEqual(presets.get(id).profile, preset.profile)) {
            id = `migrated-${kind}-${createHash("sha256").update(JSON.stringify(preset.profile)).digest("hex")}`;
        }
        const existing = presets.get(id);
        if (existing && !isDeepStrictEqual(existing.profile, preset.profile)) throw new Error(`Preset migration conflict: ${id}`);
        if (!existing) {
            await client.query(`INSERT INTO ${kind}_parameter_presets(id,label,profile) VALUES($1,$2,$3)`, [id, preset.label, JSON.stringify(preset.profile)]);
            presets.set(id, { id, ...preset });
        }
        return id;
    };
    for (const channel of channels) {
        if (channel.capability === "image") {
            const bindings: Record<string, string> = { ...channel.image_presets };
            for (const model of channel.models) {
                const family = channel.image_types?.[model];
                if (!Object.hasOwn(snapshot.image, family)) throw new Error(`Cannot migrate image type for model: ${model}`);
                if (bindings[model]) {
                    if (imagePresets.get(bindings[model])?.profile.family !== family) throw new Error(`Invalid image preset reference for model: ${model}`);
                    continue;
                }
                const name = model.split("::").pop() || "", profiles = snapshot.image[family];
                const key = Object.hasOwn(profiles, name) ? name : "";
                bindings[model] = await ensurePreset("image", key || `${family}-default`, profiles[key]);
            }
            if (!isDeepStrictEqual(bindings, channel.image_presets)) await client.query("UPDATE channels SET image_presets=$2 WHERE id=$1", [channel.id, JSON.stringify(bindings)]);
        }
        if (channel.capability === "video") for (const model of channel.models) {
            const id = channel.video_presets?.[model], callType = channel.video_types?.[model];
            const existing = videoPresets.get(id);
            if (existing) {
                if ((existing.profile.family === "seedance" ? "seedance" : "tokenone") !== callType) throw new Error(`Invalid video preset reference for model: ${model}`);
                continue;
            }
            const preset = Object.hasOwn(snapshot.video, id) ? snapshot.video[id] : undefined;
            if (!preset || preset.callType !== callType) throw new Error(`Cannot migrate video preset ${id} for model: ${model}`);
            await ensurePreset("video", id, preset);
        }
    }
    await client.query("INSERT INTO app_data_migrations(id,backup) VALUES($1,$2)", [parameterPresetsMigrationId, JSON.stringify(backup)]);
}
