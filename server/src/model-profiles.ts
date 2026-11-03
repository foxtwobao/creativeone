import type { PoolClient } from "pg";
import { db } from "./db.js";
import { attachImageProfiles } from "./image-presets.js";
import { attachVideoProfiles } from "./video-presets.js";

export async function attachModelProfiles<T extends { capability: string; image_presets?: Record<string, string>; video_presets?: Record<string, string> }>(channels: T[], client: Pick<PoolClient, "query"> = db) {
    return attachImageProfiles(await attachVideoProfiles(channels, client), client);
}
