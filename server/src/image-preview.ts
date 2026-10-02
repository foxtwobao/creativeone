import { access, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { IMAGE_PREVIEW_MAX_EDGE, IMAGE_PREVIEW_QUALITY } from "../../shared/image-preview.js";

const pending = new Map<string, Promise<string>>();
export const imagePreviewPath = (original: string) => `${original}.preview.webp`;

export function ensureImagePreviewFile(original: string): Promise<string> {
    const existing = pending.get(original);
    if (existing) return existing;
    const work = (async () => {
        const path = imagePreviewPath(original);
        try { await access(path); return path; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const bytes = await sharp(original).rotate().resize(IMAGE_PREVIEW_MAX_EDGE, IMAGE_PREVIEW_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: IMAGE_PREVIEW_QUALITY }).toBuffer();
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, bytes); await rename(temporary, path); }
        finally { await unlink(temporary).catch(() => undefined); }
        return path;
    })().finally(() => pending.delete(original));
    pending.set(original, work);
    return work;
}
