import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { HttpError } from "./http.js";
import { readAccountData, changeAccountData } from "./account-data.js";
import { isAllowedMediaUrl } from "./media-hosts.js";
import { DEFAULT_PROMPT_SOURCES, type PromptSource } from "../../shared/prompt-sources.js";
import { promptImageProxyUrl } from "../../shared/prompt-image-proxy.js";
import { normalizePromptItems } from "../../shared/prompt-items.js";

export const promptsRouter = Router();
const sourceKey = "infinite-canvas:prompt_source_store_v2";
const defaults = { sources: DEFAULT_PROMPT_SOURCES };
const refreshIntervalMs = 30 * 60_000;
const input = z.object({ id: z.string().optional(), name: z.string(), url: z.url(), homepage: z.string(), enabled: z.boolean(), builtIn: z.boolean().optional() }).strict();
const settings = async (userId: string) => ({ sources: (await readAccountData(userId, sourceKey, defaults)).sources as PromptSource[] });
const sourceUrl = (source: PromptSource) => { const url = new URL(source.url); url.hash = ""; return url.href; };
type PromptCache = { revision: string; source_url: string; items: unknown[]; last_success_at: Date | null; last_attempt_at: Date; last_error: string };
const running = new Map<string, Promise<PromptCache>>();

async function refresh(source: PromptSource, mode: "missing" | "due" | "manual" = "manual"): Promise<PromptCache> {
    const url = sourceUrl(source);
    const existing = running.get(url); if (existing) return existing;
    const action = (async () => {
        const previous = (await db.query<PromptCache>("SELECT * FROM prompt_source_caches WHERE source_url=$1", [url])).rows[0];
        if (previous && mode !== "manual" && (mode === "missing" && previous.last_success_at || Date.now() - previous.last_attempt_at.getTime() < refreshIntervalMs)) return previous;
        return transaction(async client => {
            // Serialize the same public URL across API processes, then recheck after waiting.
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`prompt-source:${url}`]);
            const cached = (await client.query<PromptCache>("SELECT * FROM prompt_source_caches WHERE source_url=$1", [url])).rows[0];
            if (cached && (mode === "missing" && cached.last_success_at || mode !== "manual" && Date.now() - cached.last_attempt_at.getTime() < refreshIntervalMs
                || cached.revision !== previous?.revision)) return cached;
            let error = "", items: unknown[] = [];
            try {
                if (!isAllowedMediaUrl(new URL(url), ["raw.githubusercontent.com", ...env.MEDIA_DOWNLOAD_HOSTS.split(",")])) throw new HttpError(400, "PROMPT_SOURCE_HOST_NOT_ALLOWED");
                const response = await fetch(url, { redirect: "error" });
                if (!response.ok || !response.body) throw new HttpError(502, "PROMPT_SOURCE_FETCH_FAILED");
                const chunks: Uint8Array[] = []; let size = 0;
                for await (const chunk of response.body as any) { size += chunk.length; if (size > env.MAX_JSON_BYTES) throw new HttpError(413, "FILE_TOO_LARGE"); chunks.push(chunk); }
                const parsed = JSON.parse(Buffer.concat(chunks).toString());
                if (!Array.isArray(parsed)) throw new HttpError(400, "PROMPT_SOURCE_INVALID_JSON");
                items = parsed;
            } catch (failure) { error = failure instanceof HttpError ? failure.code : "PROMPT_SOURCE_FETCH_FAILED"; }
            if (error) return (await client.query<PromptCache>(`INSERT INTO prompt_source_caches(source_url,last_error) VALUES($1,$2)
                ON CONFLICT(source_url) DO UPDATE SET last_error=$2,last_attempt_at=clock_timestamp(),revision=prompt_source_caches.revision+1 RETURNING *`, [url, error])).rows[0];
            return (await client.query<PromptCache>(`INSERT INTO prompt_source_caches(source_url,items,last_success_at) VALUES($1,$2,clock_timestamp())
                ON CONFLICT(source_url) DO UPDATE SET items=$2,last_success_at=clock_timestamp(),last_attempt_at=clock_timestamp(),last_error='',revision=prompt_source_caches.revision+1 RETURNING *`, [url, JSON.stringify(items)])).rows[0];
        });
    })().finally(() => running.delete(url));
    running.set(url, action); return action;
}
function cacheStatus(source: PromptSource, cache: PromptCache) {
    return { sourceId: source.id, count: normalizePromptItems(cache.items, source).length, lastSuccessAt: cache.last_success_at?.toISOString() || "", lastError: cache.last_error };
}
promptsRouter.get("/prompt-sources", async (_req, res) => res.json(await settings(res.locals.user.id)));
promptsRouter.post("/prompt-sources", async (req, res) => {
    const body = input.parse(req.body); const source = { ...body, id: randomUUID(), builtIn: false };
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ sources: [...state.sources, source] })));
});
promptsRouter.patch("/prompt-sources/:id", async (req, res) => {
    const patch = input.partial().parse(req.body);
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ sources: state.sources.map((source: PromptSource) => source.id === req.params.id ? source.builtIn ? { ...source, enabled: patch.enabled ?? source.enabled } : { ...source, ...patch, id: source.id, builtIn: false } : source) })));
});
promptsRouter.delete("/prompt-sources/:id", async (req, res) => {
    res.json(await changeAccountData(res.locals.user.id, sourceKey, defaults, (state) => ({ sources: state.sources.filter((source: PromptSource) => source.id !== req.params.id || source.builtIn) })));
});
promptsRouter.get("/prompt-source-statuses", async (_req, res) => {
    const { sources } = await settings(res.locals.user.id);
    const { rows } = await db.query<PromptCache>("SELECT * FROM prompt_source_caches WHERE source_url=ANY($1::text[])", [sources.map(sourceUrl)]);
    res.json(Object.fromEntries(sources.flatMap(source => { const cache = rows.find(row => row.source_url === sourceUrl(source)); return cache ? [[source.id, cacheStatus(source, cache)]] : []; })));
});
promptsRouter.post("/prompt-sources/refresh", async (req, res) => {
    const { sourceId } = z.object({ sourceId: z.string().optional() }).strict().parse(req.body);
    const state = await settings(res.locals.user.id);
    const sources = state.sources.filter((source: PromptSource) => sourceId ? source.id === sourceId : source.enabled);
    const results = await Promise.all(sources.map(async source => { const cache = await refresh(source); return { ...cacheStatus(source, cache), sourceName: source.name, success: !cache.last_error }; }));
    res.json({ results, total: results.reduce((n: number,r: any) => n+r.count,0), successCount: results.filter((r: any) => r.success).length, failureCount: results.filter((r: any) => !r.success).length });
});
export const promptSearchPageSize=z.number().int().min(1).max(100);
export async function searchPrompts(userId:string,value:unknown) {
    const query = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().pipe(promptSearchPageSize).default(20), keyword: z.string().default(""), category: z.string().default("all"), sourceId: z.string().optional(), tag: z.union([z.string(), z.array(z.string())]).optional() }).parse(value);
    const state = await settings(userId);
    const sources = state.sources.filter((source: PromptSource) => query.sourceId ? source.id === query.sourceId : source.enabled);
    const caches = await Promise.all(sources.map(source => refresh(source, "missing")));
    // Normalize per account so shared JSON never contains another account's source ID or label.
    const all = sources.flatMap((source, index) => normalizePromptItems(caches[index].items, source).map(item => ({ ...item, sourceId: source.id, category: source.name, githubUrl: source.homepage })));
    const tags = Array.isArray(query.tag) ? query.tag : query.tag ? [query.tag] : [];
    const base = all.filter((item: any) => (query.category === "all" || item.category === query.category) && (!query.keyword || `${item.title} ${item.prompt} ${item.description} ${item.category} ${item.tags.join(" ")}`.toLowerCase().includes(query.keyword.toLowerCase())));
    const items = base.filter((item: any) => !tags.length || tags.some((tag) => item.tags.includes(tag)));
    const imageProxy = env.PROMPT_GITHUB_PROXY_BASE;
    const pageItems = items.slice((query.page-1)*query.pageSize,query.page*query.pageSize).map(item => ({ ...item,
        coverUrl: promptImageProxyUrl(item.coverUrl, imageProxy),
        referenceImageUrls: item.referenceImageUrls.map((url: string) => promptImageProxyUrl(url, imageProxy)),
    }));
    return { items: pageItems, total: items.length, tags: [...new Set(base.flatMap((item: any) => item.tags))], categories: sources.map((source: PromptSource) => source.name) };
}
promptsRouter.get("/prompts",async(req,res)=>res.json(await searchPrompts(res.locals.user.id,req.query)));
export async function refreshDuePromptSources() {
    const sources = new Map(DEFAULT_PROMPT_SOURCES.map(source => [sourceUrl(source), source]));
    const users = (await db.query("SELECT user_id FROM documents WHERE namespace='app_state' AND key=$1 AND NOT deleted", [sourceKey])).rows;
    for (const { user_id } of users) for (const source of (await settings(user_id)).sources) if (source.enabled) sources.set(sourceUrl(source), source);
    const { rows } = await db.query<PromptCache>("SELECT * FROM prompt_source_caches WHERE last_attempt_at <= now() - interval '30 minutes'");
    for (const cache of rows) { const source = sources.get(cache.source_url); if (source) await refresh(source, "due"); }
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
