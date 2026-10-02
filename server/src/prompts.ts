import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./config.js";
import { HttpError } from "./http.js";
import { readAccountData, changeAccountData } from "./account-data.js";
import { isAllowedMediaUrl } from "./media-hosts.js";
import { DEFAULT_PROMPT_SOURCES, type PromptSource } from "../../shared/prompt-sources.js";
import { normalizePromptItems } from "../../shared/prompt-items.js";

export const promptsRouter = Router();
const sourceKey = "infinite-canvas:prompt_source_store_v2";
const defaults = { sources: DEFAULT_PROMPT_SOURCES, schedule: { intervalMinutes: 30, lastFetchedAt: "" } };
const input = z.object({ id: z.string().optional(), name: z.string(), url: z.url(), homepage: z.string(), enabled: z.boolean(), builtIn: z.boolean().optional() }).strict();
const running = new Map<string, Promise<any>>();
const settings = (userId: string) => readAccountData(userId, sourceKey, defaults);
async function refresh(userId: string, source: PromptSource) {
    const key = `${userId}:${source.id}`;
    const existing = running.get(key); if (existing) return existing;
    const action = (async () => {
        let error = "", items: unknown[] = [];
        try {
            if (!isAllowedMediaUrl(new URL(source.url), ["raw.githubusercontent.com", ...env.MEDIA_DOWNLOAD_HOSTS.split(",")])) throw new HttpError(400, "PROMPT_SOURCE_HOST_NOT_ALLOWED");
            const response = await fetch(source.url, { redirect: "error" });
            if (!response.ok) throw new HttpError(502, "PROMPT_SOURCE_FETCH_FAILED");
            const chunks: Uint8Array[] = []; let size = 0;
            if (!response.body) throw new HttpError(502, "PROMPT_SOURCE_FETCH_FAILED");
            for await (const chunk of response.body as any) { size += chunk.length; if (size > env.MAX_JSON_BYTES) throw new HttpError(413, "FILE_TOO_LARGE"); chunks.push(chunk); }
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            if (!Array.isArray(parsed)) throw new HttpError(400, "PROMPT_SOURCE_INVALID_JSON");
            items = normalizePromptItems(parsed, source).map((item) => ({ ...item, sourceId: source.id, category: source.name, githubUrl: source.homepage }));
            await db.query("INSERT INTO prompt_caches(user_id,source_id,source_url,items,last_success_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(user_id,source_id) DO UPDATE SET source_url=$3,items=$4,last_success_at=now(),last_attempt_at=now(),last_error=''", [userId, source.id, source.url, JSON.stringify(items)]);
        } catch (failure) {
            error = failure instanceof HttpError ? failure.code : "PROMPT_SOURCE_FETCH_FAILED";
            await db.query("INSERT INTO prompt_caches(user_id,source_id,source_url,last_error) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,source_id) DO UPDATE SET last_error=$4,last_attempt_at=now()", [userId, source.id, source.url, error]);
        }
        const { rows } = await db.query("SELECT * FROM prompt_caches WHERE user_id=$1 AND source_id=$2", [userId, source.id]);
        const cache = rows[0];
        if (!error) await changeAccountData(userId, sourceKey, defaults, (state) => ({ ...state, schedule: { ...state.schedule, lastFetchedAt: cache.last_success_at.toISOString() } }));
        return { sourceId: source.id, sourceName: source.name, count: cache.items.length, lastSuccessAt: cache.last_success_at?.toISOString() || "", lastError: cache.last_error, success: !error };
    })().finally(() => running.delete(key));
    running.set(key, action); return action;
}
promptsRouter.get("/prompt-sources", async (_req, res) => res.json(await settings(res.locals.user.id)));
promptsRouter.post("/prompt-sources", async (req, res) => {
    const body = input.parse(req.body); const source = { ...body, id: randomUUID(), builtIn: false };
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ ...state, sources: [...state.sources, source] })));
});
promptsRouter.patch("/prompt-sources/:id", async (req, res) => {
    const patch = input.partial().parse(req.body);
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ ...state, sources: state.sources.map((source: PromptSource) => source.id === req.params.id ? source.builtIn ? { ...source, enabled: patch.enabled ?? source.enabled } : { ...source, ...patch, id: source.id, builtIn: false } : source) })));
});
promptsRouter.delete("/prompt-sources/:id", async (req, res) => {
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ ...state, sources: state.sources.filter((source: PromptSource) => source.id !== req.params.id || source.builtIn) })));
    await db.query("DELETE FROM prompt_caches WHERE user_id=$1 AND source_id=$2", [res.locals.user.id, req.params.id]);
});
promptsRouter.patch("/prompt-schedule", async (req, res) => {
    const { intervalMinutes } = z.object({ intervalMinutes: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(360), z.literal(1440)]) }).strict().parse(req.body);
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ ...state, schedule: { ...state.schedule, intervalMinutes } })));
});
promptsRouter.get("/prompt-source-statuses", async (_req, res) => {
    const { rows } = await db.query("SELECT source_id,jsonb_array_length(items) AS count,last_success_at,last_error FROM prompt_caches WHERE user_id=$1", [res.locals.user.id]);
    res.json(Object.fromEntries(rows.map((row) => [row.source_id, { sourceId: row.source_id, count: row.count, lastSuccessAt: row.last_success_at?.toISOString() || "", lastError: row.last_error }])));
});
promptsRouter.post("/prompt-sources/refresh", async (req, res) => {
    const { sourceId } = z.object({ sourceId: z.string().optional() }).strict().parse(req.body);
    const state = await settings(res.locals.user.id);
    const sources = state.sources.filter((source: PromptSource) => sourceId ? source.id === sourceId : source.enabled);
    const results = await Promise.all(sources.map((source: PromptSource) => refresh(res.locals.user.id, source)));
    res.json({ results, total: results.reduce((n: number,r: any) => n+r.count,0), successCount: results.filter((r: any) => r.success).length, failureCount: results.filter((r: any) => !r.success).length });
});
promptsRouter.get("/prompts", async (req, res) => {
    const query = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), keyword: z.string().default(""), category: z.string().default("all"), sourceId: z.string().optional(), tag: z.union([z.string(), z.array(z.string())]).optional() }).parse(req.query);
    const state = await settings(res.locals.user.id);
    const sources = state.sources.filter((source: PromptSource) => query.sourceId ? source.id === query.sourceId : source.enabled);
    const { rows } = await db.query("SELECT * FROM prompt_caches WHERE user_id=$1", [res.locals.user.id]);
    await Promise.all(sources.filter((source: PromptSource) => !rows.some((row) => row.source_id === source.id && row.source_url === source.url && row.last_success_at)).map((source: PromptSource) => refresh(res.locals.user.id, source)));
    const caches = (await db.query("SELECT source_id,items FROM prompt_caches WHERE user_id=$1", [res.locals.user.id])).rows;
    const all = caches.filter((row) => sources.some((source: PromptSource) => source.id === row.source_id)).flatMap((row) => { const source = sources.find((item: PromptSource) => item.id === row.source_id)!; return row.items.map((item: any) => ({ ...item, category: source.name, githubUrl: source.homepage })); });
    const tags = Array.isArray(query.tag) ? query.tag : query.tag ? [query.tag] : [];
    const base = all.filter((item: any) => (query.category === "all" || item.category === query.category) && (!query.keyword || `${item.title} ${item.prompt} ${item.description} ${item.category} ${item.tags.join(" ")}`.toLowerCase().includes(query.keyword.toLowerCase())));
    const items = base.filter((item: any) => !tags.length || tags.some((tag) => item.tags.includes(tag)));
    res.json({ items: items.slice((query.page-1)*query.pageSize,query.page*query.pageSize), total: items.length, tags: [...new Set(base.flatMap((item: any) => item.tags))], categories: sources.map((source: PromptSource) => source.name) });
});
export async function refreshDuePromptSources() {
    const users = (await db.query("SELECT DISTINCT user_id FROM prompt_caches WHERE last_success_at IS NOT NULL")).rows;
    for (const { user_id } of users) {
        const state = await settings(user_id); if (!state.schedule.intervalMinutes) continue;
        const caches = (await db.query("SELECT source_id,last_success_at,last_attempt_at FROM prompt_caches WHERE user_id=$1", [user_id])).rows;
        for (const source of state.sources.filter((item: PromptSource) => item.enabled)) {
            const cache = caches.find((item) => item.source_id === source.id);
            if (cache?.last_success_at && Date.now()-Date.parse(cache.last_attempt_at) >= state.schedule.intervalMinutes*60_000) await refresh(user_id, source);
        }
    }
}
export function startPromptWorker() {
    let working = false;
    const tick = async () => {
        if (working) return; working = true;
        try { await refreshDuePromptSources(); }
        catch { console.warn("Prompt refresh worker failed"); } finally { working = false; }
    };
    const timer = setInterval(() => void tick(), 60_000); void tick();
    return () => clearInterval(timer);
}
