import pg from "pg";
import { readFile } from "node:fs/promises";
import { env } from "./config.js";

import { migrateParameterPresets } from "./migrations/parameter-presets.js";
import { defaultImageParameterPresets } from "../../shared/image-models.js";
import { defaultVideoParameterPresets } from "../../shared/video-models.js";

export const db = new pg.Pool({ connectionString: env.DATABASE_URL });
export async function initializeDatabase() {
    const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('creativeone-schema'))");
        const existing = (await client.query("SELECT to_regclass('video_parameter_presets') AS name")).rows[0].name;
        const imageExisting = (await client.query("SELECT to_regclass('image_parameter_presets') AS name")).rows[0].name;
        await client.query(schema);
        await migrateParameterPresets(client);
        if (!imageExisting) for (const [id, preset] of Object.entries(defaultImageParameterPresets)) {
            await client.query("INSERT INTO image_parameter_presets(id,label,profile) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [id, preset.label, JSON.stringify(preset.profile)]);
        }
        if (!existing) for (const [id, preset] of Object.entries(defaultVideoParameterPresets)) {
            await client.query("INSERT INTO video_parameter_presets(id,label,profile) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [id, preset.label, JSON.stringify(preset.profile)]);
        }
    });
}
export async function transaction<T>(run: (client: Pick<pg.PoolClient, "query">) => Promise<T>, owner?: pg.Client): Promise<T> {
    const client = owner || await db.connect();
    try {
        await client.query("BEGIN");
        const result = await run(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally { if (!owner) (client as pg.PoolClient).release(); }
}
