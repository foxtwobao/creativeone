import { Router, raw } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { HttpError, requireKey } from "./http.js";

const namespace = z.enum(["app_state", "preferences", "image_generation_logs", "video_generation_logs"]);
const fileNamespace = z.enum(["image_files", "media_files"]);
const mediaRoot = resolve(env.MEDIA_DIR);
export const fileUrl = (ns: string, key: string) => `/api/files/${ns}/${key}`;

function fileReferences(value: unknown, references = new Set<string>()): Set<string> {
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
        Object.values(record).forEach((item) => fileReferences(item, references));
    }
    return references;
}
export async function saveFile(userId: string, ns: string, key: string, bytes: Buffer, mime: string) {
    if (bytes.length > env.MAX_MEDIA_BYTES) throw new HttpError(413, "FILE_TOO_LARGE");
    if (!/^(image\/(png|jpeg|webp|gif|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/octet-stream)$/.test(mime)) throw new HttpError(415, "UNSUPPORTED_MEDIA");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const diskId = randomUUID();
    await mkdir(mediaRoot, { recursive: true });
    await writeFile(resolve(mediaRoot, diskId), bytes, { flag: "wx" });
    try {
        const result = await db.query("INSERT INTO files (user_id,namespace,key,disk_id,mime_type,bytes,digest) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING disk_id", [userId, ns, key, diskId, mime, bytes.length, digest]);
        if (!result.rowCount) {
            await unlink(resolve(mediaRoot, diskId));
            const old = await db.query("SELECT digest FROM files WHERE user_id=$1 AND namespace=$2 AND key=$3", [userId, ns, key]);
            if (old.rows[0]?.digest !== digest) throw new HttpError(409, "FILE_KEY_CONFLICT");
        }
    } catch (error) { await unlink(resolve(mediaRoot, diskId)).catch(() => undefined); throw error; }
    return fileUrl(ns, key);
}

// Deletion is requested explicitly. References in other devices' documents and
// server generation records keep the file alive; there is no age-based pruning.
async function collectDeletedFiles(userId: string) {
    const deleted = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const documents = await client.query("SELECT value FROM documents WHERE user_id=$1 AND NOT deleted UNION ALL SELECT result AS value FROM generation_tasks WHERE user_id=$1 AND result IS NOT NULL", [userId]);
        const references = new Set<string>();
        for (const row of documents.rows) fileReferences(row.value, references);
        const { rows } = await client.query("DELETE FROM files WHERE user_id=$1 AND delete_requested AND NOT (key=ANY($2::text[])) RETURNING disk_id", [userId, [...references]]);
        return rows;
    });
    for (const row of deleted) await unlink(resolve(mediaRoot, row.disk_id)).catch(() => undefined);
}
export const storageRouter = Router();
storageRouter.get("/storage/:namespace", async (req, res) => {
    const ns = namespace.parse(req.params.namespace);
    res.json({ entries: (await db.query("SELECT key,value,revision,deleted FROM documents WHERE user_id=$1 AND namespace=$2 ORDER BY key", [res.locals.user.id, ns])).rows });
});
storageRouter.put("/storage/:namespace/:key", async (req, res) => {
    const ns = namespace.parse(req.params.namespace), key = requireKey(req.params.key);
    const body = z.object({ value: z.unknown(), revision: z.number().int().nonnegative(), deleted: z.boolean() }).strict().parse(req.body);
    const serialized = JSON.stringify(body.value ?? null);
    if (/"blob:[^"]*"/.test(serialized)) throw new HttpError(400, "LOCAL_BLOB_NOT_SYNCABLE");
    const revision = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [res.locals.user.id]);
        const current = await client.query("SELECT revision FROM documents WHERE user_id=$1 AND namespace=$2 AND key=$3", [res.locals.user.id, ns, key]);
        if ((current.rows[0]?.revision || 0) !== body.revision) throw new HttpError(409, "SYNC_CONFLICT");
        if (!body.deleted) for (const reference of fileReferences(body.value)) {
            const file = await client.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [res.locals.user.id, reference]);
            if (!file.rowCount) throw new HttpError(409, "FILE_NOT_SYNCED");
        }
        const next = body.revision + 1;
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
    res.setHeader("Content-Type", rows[0].mime_type);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.sendFile(resolve(mediaRoot, rows[0].disk_id));
});
storageRouter.delete("/files/:namespace/:key", async (req, res) => {
    const ns = fileNamespace.parse(req.params.namespace), key = requireKey(req.params.key);
    await db.query("UPDATE files SET delete_requested=true WHERE user_id=$1 AND namespace=$2 AND key=$3", [res.locals.user.id, ns, key]);
    await collectDeletedFiles(res.locals.user.id);
    res.json({ ok: true });
});
