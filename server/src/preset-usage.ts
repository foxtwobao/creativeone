import { db } from "./db.js";
import type { PresetListItem } from "../../shared/preset-usage.js";

export async function withPresetUsage<T extends { id: string }>(presets: T[], capability: "image" | "video"): Promise<PresetListItem<T>[]> {
    const { rows } = await db.query<{ models: string[]; enabled: boolean; presets: Record<string, string> }>(`SELECT models,enabled,${capability}_presets AS presets FROM channels WHERE capability=$1`, [capability]);
    return presets.map(preset => ({ ...preset, usedBy: rows.flatMap(channel => channel.models.filter(model => channel.presets[model] === preset.id).map(model => ({ model, enabled: channel.enabled }))) }));
}
