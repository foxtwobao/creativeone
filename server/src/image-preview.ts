import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
        const image = sharp(original, { animated: true });
        const { pages = 1 } = await image.metadata();
        try {
            await access(path);
            // Read bytes because the cached file can be replaced at the same path.
            if (pages === 1 || (await sharp(await readFile(path), { animated: true }).metadata()).pages === pages) return path;
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const bytes = await image.rotate().resize(IMAGE_PREVIEW_MAX_EDGE, IMAGE_PREVIEW_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: IMAGE_PREVIEW_QUALITY }).toBuffer();
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, bytes); await rename(temporary, path); }
        finally { await unlink(temporary).catch(() => undefined); }
        return path;
    })().finally(() => pending.delete(original));
    pending.set(original, work);
    return work;
}
