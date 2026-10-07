import multer from "multer";
import { Router, raw } from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { HttpError, requireKey } from "./http.js";
import { storedMediaMetadata } from "./media-metadata.js";
import { ensureImagePreviewFile, imagePreviewPath } from "./image-preview.js";

const namespace = z.enum(["app_state", "preferences", "image_generation_logs", "video_generation_logs"]);
const fileNamespace = z.enum(["image_files", "media_files"]);
const mediaRoot = resolve(env.MEDIA_DIR);
export const fileUrl = (ns: string, key: string) => `/api/files/${ns}/${key}`;

function referenceSignature(diskId: string, expires: string) {
    return createHmac("sha256", env.IDONE_CLIENT_SECRET).update(`wan-media:${diskId}:${expires}`).digest("hex");
}

function signedMediaUrl(diskId: string, expiresAt: number) {
    const expires = String(expiresAt);
    const url = new URL(`/api/public/media/${diskId}`, env.APP_ORIGIN);
    url.searchParams.set("expires", expires);
    url.searchParams.set("signature", referenceSignature(diskId, expires));
    return url.toString();
}

export async function mediaReferenceForUser(userId: string, ns: string, key: string, expiresAt: number) {
    if (new URL(env.APP_ORIGIN).protocol !== "https:") throw new HttpError(409, "WAN_PUBLIC_ORIGIN_REQUIRED");
    const { rows } = await db.query("SELECT disk_id FROM files WHERE user_id=$1 AND namespace=$2 AND key=$3", [userId, ns, key]);
    if (!rows[0]) throw new HttpError(404, "FILE_NOT_FOUND");
    return signedMediaUrl(rows[0].disk_id, expiresAt);
}

export const publicMediaRouter = Router();
publicMediaRouter.get("/public/media/:diskId", async (req, res) => {
    const diskId = z.uuid().parse(req.params.diskId);
    const expires = String(req.query.expires || "");
    const signature = String(req.query.signature || "");
    if (!/^\d+$/.test(expires) || Number(expires) <= Date.now() || !/^[a-f0-9]{64}$/.test(signature)) throw new HttpError(403, "MEDIA_LINK_EXPIRED");
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(referenceSignature(diskId, expires), "hex"))) throw new HttpError(403, "MEDIA_LINK_EXPIRED");
    const { rows } = await db.query("SELECT mime_type FROM files WHERE disk_id=$1", [diskId]);
    if (!rows[0]) throw new HttpError(404, "FILE_NOT_FOUND");
    res.setHeader("Content-Type", rows[0].mime_type);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.sendFile(resolve(mediaRoot, diskId));
});

export function fileReferences(value: unknown, references = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        if (value.startsWith("blob:")) throw new HttpError(400, "LOCAL_BLOB_NOT_SYNCABLE");
        const url = /^\/api\/files\/(?:image_files|media_files)\/([^/?#]+)$/.exec(value);
        if (url) references.add(decodeURIComponent(url[1]));
        if (value.startsWith("{") || value.startsWith("[")) {
            let parsed: unknown;
            try { parsed = JSON.parse(value); } catch { return references; }
            fileReferences(parsed, references);
        }
    } else if (Array.isArray(value)) value.forEach((item) => fileReferences(item, references));
    else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.storageKey === "string" && record.storageKey) references.add(record.storageKey);
        if (Array.isArray(record.references)) for (const key of record.references) if (typeof key === "string" && /^(image|file|video|audio):/.test(key)) references.add(key);
        Object.values(record).forEach((item) => fileReferences(item, references));
    }
    return references;
}
export async function saveFile(userId: string, ns: string, key: string, bytes: Buffer, mime: string, client: Pick<typeof db, "query"> = db) {
    if (bytes.length > env.MAX_MEDIA_BYTES) throw new HttpError(413, "FILE_TOO_LARGE");
    if (!/^(image\/(png|jpeg|webp|gif|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/octet-stream)$/.test(mime)) throw new HttpError(415, "UNSUPPORTED_MEDIA");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const diskId = randomUUID();
    await mkdir(mediaRoot, { recursive: true });
    await writeFile(resolve(mediaRoot, diskId), bytes, { flag: "wx" });
    try {
        const result = await client.query("INSERT INTO files (user_id,namespace,key,disk_id,mime_type,bytes,digest) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING disk_id", [userId, ns, key, diskId, mime, bytes.length, digest]);
        if (!result.rowCount) {
            await unlink(resolve(mediaRoot, diskId));
            const old = await client.query("SELECT digest FROM files WHERE user_id=$1 AND namespace=$2 AND key=$3", [userId, ns, key]);
            if (old.rows[0]?.digest !== digest) throw new HttpError(409, "FILE_KEY_CONFLICT");
        }
    } catch (error) { await unlink(resolve(mediaRoot, diskId)).catch(() => undefined); throw error; }
    return fileUrl(ns, key);
}

// Deletion is requested explicitly. References in other devices' documents and
// server generation records keep the file alive; there is no age-based pruning.
export async function collectDeletedFiles(userId: string, candidates: string[] = []) {
    const deleted = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        await client.query("UPDATE files SET delete_requested=true WHERE user_id=$1 AND key=ANY($2::text[])", [userId, candidates]);
        const documents = await client.query("SELECT value FROM documents WHERE user_id=$1 AND NOT deleted UNION ALL SELECT jsonb_build_object('nodes',nodes,'connections',connections,'chatSessions',chat_sessions) AS value FROM canvas_projects WHERE user_id=$1 AND deleted_at IS NULL UNION ALL SELECT c.inverse AS value FROM canvas_project_commands c JOIN canvas_projects p ON p.id=c.project_id WHERE p.user_id=$1 AND p.deleted_at IS NULL AND c.inverse IS NOT NULL UNION ALL SELECT result AS value FROM generation_tasks WHERE user_id=$1 AND result IS NOT NULL AND NOT (hidden_from_works AND hidden_from_history) UNION ALL SELECT request AS value FROM generation_tasks WHERE user_id=$1 AND request IS NOT NULL AND NOT (hidden_from_works AND hidden_from_history)", [userId]);
        const references = new Set<string>();
        for (const row of documents.rows) fileReferences(row.value, references);
        const { rows } = await client.query("DELETE FROM files WHERE user_id=$1 AND (delete_requested OR key=ANY($3::text[])) AND NOT (key=ANY($2::text[])) RETURNING disk_id", [userId, [...references], candidates]);
        return rows;
    });
    for (const row of deleted) {
        const path = resolve(mediaRoot, row.disk_id);
        await Promise.all([unlink(path).catch(() => undefined), unlink(imagePreviewPath(path)).catch(() => undefined)]);
    }
}
export const storageRouter = Router();
storageRouter.post("/files/canvas-import", multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_MEDIA_BYTES } }).single("file"), async (req, res) => {
    if (!req.file || !/^(image|video|audio)\//.test(req.file.mimetype)) throw new HttpError(415, "UNSUPPORTED_MEDIA");
    const image = req.file.mimetype.startsWith("image/");
    if (image) {
        const metadata = await sharp(req.file.buffer).metadata().catch(() => null);
        if (!metadata?.width || !metadata.height) throw new HttpError(400, "INVALID_CANVAS_ARCHIVE");
    }
    const key = `${image ? "image" : "file"}:${randomUUID()}`;
    const url = await saveFile(res.locals.user.id, image ? "image_files" : "media_files", key, req.file.buffer, req.file.mimetype);
    res.status(201).json(await storedFileInfo(res.locals.user.id, url));
});
export async function storedFileInfo(userId: string, url: string, client: Pick<typeof db, "query"> = db) {
    const match = /^\/api\/files\/(image_files|media_files)\/([^/?#]+)$/.exec(url);
    if (!match) throw new HttpError(400, "INVALID_FILE_REFERENCE");
    const ns = match[1], key = decodeURIComponent(match[2]);
    const { rows } = await client.query("SELECT * FROM files WHERE user_id=$1 AND namespace=$2 AND key=$3", [userId, ns, key]);
    if (!rows[0]) throw new HttpError(404, "FILE_NOT_FOUND");
    const file = rows[0];
    const metadata = file.mime_type.startsWith("image/") ? await sharp(resolve(mediaRoot, file.disk_id)).metadata().catch(() => ({} as { width?: number; height?: number })) : await storedMediaMetadata(file.disk_id, file.mime_type);
    return { url: fileUrl(ns, key), storageKey: key, bytes: Number(file.bytes), mimeType: file.mime_type, width: metadata.width || 0, height: metadata.height || 0, ...("durationMs" in metadata ? { durationMs: metadata.durationMs } : {}) };
}
export async function inlineStoredFile(userId: string, url: string) {
    const file = await storedFileInfo(userId, url);
    const { rows } = await db.query("SELECT disk_id FROM files WHERE user_id=$1 AND key=$2", [userId, file.storageKey]);
    return `data:${file.mimeType};base64,${(await readFile(resolve(mediaRoot, rows[0].disk_id))).toString("base64")}`;
}
storageRouter.post("/files/import", async (req, res) => {
    const { persistRemoteMedia } = await import("./media.js");
    const file = await persistRemoteMedia(res.locals.user.id, z.object({ url: z.url() }).parse(req.body).url, AbortSignal.timeout(600_000));
    res.json(await storedFileInfo(res.locals.user.id, file.url));
});
storageRouter.post("/files/info", async (req, res) => res.json(await storedFileInfo(res.locals.user.id, z.object({ url: z.string() }).parse(req.body).url)));

const assetKey = "infinite-canvas:asset_store";
const managedKeys = [assetKey, "infinite-canvas:canvas_store", "infinite-canvas:ai_config_store", "infinite-canvas:plugin_store", "infinite-canvas:prompt_source_store_v2"];
const assetFields = z.object({
    title: z.string(), coverUrl: z.string(), tags: z.array(z.string()), source: z.string().optional(), note: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
const mediaFields = { storageKey: z.string().optional(), width: z.number(), height: z.number(), bytes: z.number(), mimeType: z.string() };
const assetInput = z.discriminatedUnion("kind", [
    assetFields.extend({ kind: z.literal("text"), data: z.object({ content: z.string() }) }).strict(),
    assetFields.extend({ kind: z.literal("image"), data: z.object({ ...mediaFields, dataUrl: z.string() }) }).strict(),
    assetFields.extend({ kind: z.literal("video"), data: z.object({ ...mediaFields, url: z.string() }) }).strict(),
]);
type SavedAsset = z.infer<typeof assetInput> & { id: string; createdAt: string; updatedAt: string };
export async function readAssets(userId: string, client: Pick<typeof db, "query"> = db): Promise<SavedAsset[]> {
    const { rows } = await client.query("SELECT value FROM documents WHERE user_id=$1 AND namespace='app_state' AND key=$2 AND NOT deleted", [userId, assetKey]);
    const assets: SavedAsset[] = rows[0] ? JSON.parse(rows[0].value).state.assets : [];
    return assets.map((asset) => {
        if (asset.kind === "text" || !asset.data.storageKey) return asset;
        const url = fileUrl(asset.kind === "image" ? "image_files" : "media_files", asset.data.storageKey);
        return asset.kind === "image" ? { ...asset, data: { ...asset.data, dataUrl: url } } : { ...asset, data: { ...asset.data, url } };
    });
}
storageRouter.get("/assets", async (_req, res) => res.json({ assets: await readAssets(res.locals.user.id) }));
storageRouter.all(["/assets", "/assets/:id"], async (req, res, next) => {
    if (!["POST", "PATCH", "DELETE"].includes(req.method)) return next();
    if ((req.method === "POST") === Boolean(req.params.id)) throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const userId = res.locals.user.id;
    let removed: string[] = [];
    const asset = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const assets = await readAssets(userId, client);
        const index = assets.findIndex((item) => item.id === req.params.id);
        if (req.method !== "POST" && index < 0) throw new HttpError(404, "ASSET_NOT_FOUND");
        let saved: SavedAsset | undefined;
        if (req.method === "DELETE") { removed = [...fileReferences(assets[index])]; assets.splice(index, 1); }
        else {
            const previous = assets[index];
            const body = req.method === "POST" ? req.body : assetFields.extend({ kind: z.enum(["text", "image", "video"]), data: z.unknown() }).partial().strict().parse(req.body);
            const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...existing } = previous || {};
            const data = assetInput.parse({ ...existing, ...body });
            for (const reference of fileReferences(data)) {
                const file = await client.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [userId, reference]);
                if (!file.rowCount) throw new HttpError(409, "FILE_NOT_SYNCED");
            }
            const now = new Date().toISOString();
            saved = { ...data, id: previous?.id || randomUUID(), createdAt: previous?.createdAt || now, updatedAt: now };
            if (req.method === "POST") assets.unshift(saved); else { removed = [...fileReferences(previous)].filter((key) => !fileReferences(saved).has(key)); assets[index] = saved; }
        }
        await client.query(`INSERT INTO documents(user_id,namespace,key,value) VALUES($1,'app_state',$2,$3)
            ON CONFLICT(user_id,namespace,key) DO UPDATE SET value=EXCLUDED.value,revision=documents.revision+1,deleted=false,updated_at=now()`,
            [userId, assetKey, JSON.stringify(JSON.stringify({ state: { assets }, version: 0 }))]);
        return saved;
    });
    if (req.method === "DELETE") res.status(204).end(); else res.status(req.method === "POST" ? 201 : 200).json({ asset });
    void collectDeletedFiles(userId, removed).catch(() => undefined);
});

storageRouter.post("/files/sign", async (req, res) => {
    const body = z.object({ namespace: fileNamespace, key: z.string().regex(/^[\w:.-]+$/) }).strict().parse(req.body);
    const expiresAt = Date.now() + 30 * 60_000;
    res.json({ url: await mediaReferenceForUser(res.locals.user.id, body.namespace, body.key, expiresAt) });
});
storageRouter.get("/storage/:namespace", async (req, res) => {
    const ns = namespace.parse(req.params.namespace);
    res.json({ entries: (await db.query("SELECT key,value,revision,deleted FROM documents WHERE user_id=$1 AND namespace=$2 AND NOT (key=ANY($3::text[])) AND namespace NOT IN ('image_generation_logs','video_generation_logs') ORDER BY key", [res.locals.user.id, ns, managedKeys])).rows });
});
storageRouter.put("/storage/:namespace/:key", async (req, res) => {
    const ns = namespace.parse(req.params.namespace), key = requireKey(req.params.key);
    if (ns === "app_state" && key === assetKey) throw new HttpError(410, "ASSET_API_REQUIRED");
    if (managedKeys.includes(key) || ["image_generation_logs", "video_generation_logs"].includes(ns)) throw new HttpError(410, "RESOURCE_API_REQUIRED");
    const body = z.object({ value: z.unknown(), deleted: z.boolean() }).strict().parse(req.body);
    const serialized = JSON.stringify(body.value ?? null);
    if (/"blob:[^"]*"/.test(serialized)) throw new HttpError(400, "LOCAL_BLOB_NOT_SYNCABLE");
    const revision = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [res.locals.user.id]);
        const current = await client.query("SELECT revision FROM documents WHERE user_id=$1 AND namespace=$2 AND key=$3", [res.locals.user.id, ns, key]);
        if (!body.deleted) for (const reference of fileReferences(body.value)) {
            const file = await client.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [res.locals.user.id, reference]);
            if (!file.rowCount) throw new HttpError(409, "FILE_NOT_SYNCED");
        }
        const next = (current.rows[0]?.revision || 0) + 1;
        await client.query(`INSERT INTO documents (user_id,namespace,key,value,revision,deleted) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (user_id,namespace,key) DO UPDATE SET value=EXCLUDED.value,revision=EXCLUDED.revision,deleted=EXCLUDED.deleted,updated_at=now()`, [res.locals.user.id, ns, key, serialized, next, body.deleted]);
        return next;
    });
    res.json({ revision });
    void collectDeletedFiles(res.locals.user.id).catch(() => undefined);
});
storageRouter.put("/files/:namespace/:key", raw({ type: () => true, limit: env.MAX_MEDIA_BYTES }), async (req, res) => {
    const ns = fileNamespace.parse(req.params.namespace), key = requireKey(req.params.key);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "FILE_REQUIRED");
    res.json({ url: await saveFile(res.locals.user.id, ns, key, req.body, (req.get("Content-Type") || "application/octet-stream").split(";")[0]) });
});
storageRouter.get("/files/:namespace", async (req, res) => {
    const ns = fileNamespace.parse(req.params.namespace);
    const { rows } = await db.query("SELECT key FROM files WHERE user_id=$1 AND namespace=$2 AND NOT delete_requested ORDER BY key", [res.locals.user.id, ns]);
    res.json({ keys: rows.map((row) => row.key) });
});
storageRouter.get("/files/:namespace/:key", async (req, res) => {
    const ns = fileNamespace.parse(req.params.namespace), key = requireKey(req.params.key);
    const { rows } = await db.query("SELECT * FROM files WHERE user_id=$1 AND namespace=$2 AND key=$3", [res.locals.user.id, ns, key]);
    if (!rows[0]) throw new HttpError(404, "FILE_NOT_FOUND");
    const preview = req.query.preview === "1";
    if (preview && !rows[0].mime_type.startsWith("image/")) throw new HttpError(415, "UNSUPPORTED_MEDIA");
    const original = resolve(mediaRoot, rows[0].disk_id);
    const path = preview ? await ensureImagePreviewFile(original) : original;
    res.setHeader("Content-Type", preview ? "image/webp" : rows[0].mime_type);
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.sendFile(path);
});
storageRouter.delete("/files/:namespace/:key", async (req, res) => {
    const ns = fileNamespace.parse(req.params.namespace), key = requireKey(req.params.key);
    await db.query("UPDATE files SET delete_requested=true WHERE user_id=$1 AND namespace=$2 AND key=$3", [res.locals.user.id, ns, key]);
    await collectDeletedFiles(res.locals.user.id);
    res.json({ ok: true });
});
