import { createHash } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./config.js";
import { enhancer } from "./tokenone.js";
import { HttpError } from "./http.js";
import type { AnnouncementDetail } from "../../shared/announcements.js";

const idSchema = z.string().regex(/^[1-9]\d*$/);
const querySchema = z.object({
    limit: z.string().regex(/^\d+$/).pipe(z.coerce.number().int().min(1).max(50)).default(20),
    offset: z.string().regex(/^\d+$/).pipe(z.coerce.number().int().min(0).max(1_000_000)).default(0),
}).strict();
const itemSchema = z.object({ id: idSchema, title: z.string(), body_markdown: z.string(), published_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }) });
const listSchema = z.object({ app_id: z.string().min(1), items: z.array(itemSchema), has_more: z.boolean() });
const readSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const provider = createHash("sha256").update(env.ENHANCER_BASE_URL.replace(/\/+$/, "")).digest("hex");
const safeErrors = new Set(["INVALID_REQUEST", "UNAUTHORIZED", "APP_DISABLED", "SCOPE_FORBIDDEN", "APP_DATABASE_UNAVAILABLE", "APP_SERVICE_UNAVAILABLE", "ANNOUNCEMENT_NOT_FOUND", "ANNOUNCEMENT_CHANGED"]);

async function respond(res: Response, run: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
        // Reuse the existing application-read caller deadline; Reseller enforces its own operation limit.
        await run(AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]));
    } catch (error) {
        if (error instanceof HttpError && safeErrors.has(error.code)) throw error;
        throw new HttpError(503, "ANNOUNCEMENTS_UNAVAILABLE");
    } finally { res.off("close", cancel); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, status = 503): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new HttpError(status, status === 400 ? "INVALID_REQUEST" : "ANNOUNCEMENTS_UNAVAILABLE");
    return result.data;
}
function detail(item: z.infer<typeof itemSchema>): AnnouncementDetail {
    return { id: item.id, title: item.title, body: item.body_markdown, publishedAt: item.published_at, updatedAt: item.updated_at, read: false,
        revision: createHash("sha256").update(JSON.stringify([item.published_at, item.title, item.body_markdown])).digest("hex") };
}
async function readDetail(id: string, requestId: string, signal: AbortSignal) {
    const result = detail(parse(itemSchema, await enhancer(`/announcements/${id}`, requestId, undefined, signal)));
    if (result.id !== id) throw new HttpError(503, "ANNOUNCEMENTS_UNAVAILABLE");
    return result;
}
async function readRevisions(userId: string, items: AnnouncementDetail[]) {
    const { rows } = await db.query<{ announcement_id: string }>(`SELECT announcement_id FROM announcement_reads WHERE user_id=$1 AND provider=$2
        AND (announcement_id,revision) IN (SELECT * FROM unnest($3::text[],$4::text[]))`, [userId, provider, items.map(item => item.id), items.map(item => item.revision)]);
    return new Set(rows.map(row => row.announcement_id));
}

export const announcementsRouter = Router();
announcementsRouter.get("/announcements", (req, res) => respond(res, async signal => {
    if (req.body !== undefined) throw new HttpError(400, "INVALID_REQUEST");
    const { limit, offset } = parse(querySchema, req.query, 400);
    const result = parse(listSchema, await enhancer(`/announcements?limit=${limit}&offset=${offset}`, res.locals.requestId, undefined, signal));
    if (result.items.length > limit || (result.has_more && !result.items.length)) throw new HttpError(503, "ANNOUNCEMENTS_UNAVAILABLE");
    const items = result.items.map(detail);
    const read = await readRevisions(res.locals.user.id, items);
    res.json({ items: items.map(({ body: _body, ...item }) => ({ ...item, read: read.has(item.id) })), hasMore: result.has_more, nextOffset: offset + limit });
}));
announcementsRouter.get("/announcements/:id", (req, res) => respond(res, async signal => {
    if (Object.keys(req.query).length || req.body !== undefined) throw new HttpError(400, "INVALID_REQUEST");
    const item = await readDetail(parse(idSchema, req.params.id, 400), res.locals.requestId, signal);
    const read = await readRevisions(res.locals.user.id, [item]);
    res.json({ ...item, read: read.has(item.id) });
}));
announcementsRouter.put("/announcements/:id/read", (req, res) => respond(res, async signal => {
    if (Object.keys(req.query).length) throw new HttpError(400, "INVALID_REQUEST");
    const id = parse(idSchema, req.params.id, 400), { revision } = parse(readSchema, req.body, 400);
    const item = await readDetail(id, res.locals.requestId, signal);
    if (item.revision !== revision) throw new HttpError(409, "ANNOUNCEMENT_CHANGED");
    if (signal.aborted) return;
    await db.query("INSERT INTO announcement_reads(user_id,provider,announcement_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [res.locals.user.id, provider, id, revision]);
    res.status(204).end();
}));
