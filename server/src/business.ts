import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./config.js";
import { HttpError } from "./http.js";
import { readAccountData, changeAccountData, cleanupAccountFiles } from "./account-data.js";
import { mergeWorks, workSearchText } from "../../shared/works.js";
import { modelErrorMessage } from "./model-errors.js";
import { readAssets, fileReferences } from "./storage.js";

export const businessRouter = Router();
const projectKey = "infinite-canvas:canvas_store", configKey = "infinite-canvas:ai_config_store", pluginKey = "infinite-canvas:plugin_store";
const projectFields = z.object({ title: z.string(), nodes: z.array(z.unknown()), connections: z.array(z.unknown()), chatSessions: z.array(z.unknown()), activeChatId: z.string().nullable(), backgroundMode: z.enum(["lines", "dots", "blank"]), showImageInfo: z.boolean(), viewport: z.object({ x: z.number(), y: z.number(), k: z.number() }) });
const projectDefaults = { title: "未命名画布", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
businessRouter.get("/projects", async (_req, res) => res.json(await readAccountData(res.locals.user.id, projectKey, { projects: [], deletedProjects: [] })));
businessRouter.post("/projects", async (req, res) => {
    const input = projectFields.partial().strict().parse(req.body);
    const now = new Date().toISOString(), project = { ...projectDefaults, ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    await changeAccountData(res.locals.user.id, projectKey, { projects: [], deletedProjects: [] }, (state) => ({ ...state, projects: [project, ...state.projects] }));
    res.status(201).json({ project });
});
businessRouter.patch("/projects/:id", async (req, res) => {
    const patch = projectFields.partial().strict().parse(req.body);
    const state = await changeAccountData(res.locals.user.id, projectKey, { projects: [], deletedProjects: [] }, (state) => {
        if (!state.projects.some((item: any) => item.id === req.params.id)) throw new HttpError(404, "PROJECT_NOT_FOUND");
        return { ...state, projects: state.projects.map((item: any) => item.id === req.params.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) };
    });
    res.json({ project: state.projects.find((item: any) => item.id === req.params.id) });
});
businessRouter.delete("/projects/:id", async (req, res) => {
    await changeAccountData(res.locals.user.id, projectKey, { projects: [], deletedProjects: [] }, (state) => ({ ...state, projects: state.projects.filter((item: any) => item.id !== req.params.id), deletedProjects: [...state.deletedProjects, { id: req.params.id, deletedAt: new Date().toISOString() }] }));
    res.status(204).end();
});
const managedSettings = ["apiKey", "baseUrl", "channels", "apiFormat", "models", "modelScripts"];
const userSettings = (config: Record<string, unknown>) => Object.fromEntries(Object.entries(config).filter(([key]) => !managedSettings.includes(key)));
businessRouter.get("/settings", async (_req, res) => res.json(userSettings((await readAccountData(res.locals.user.id, configKey, { config: {} }, "preferences")).config)));
businessRouter.patch("/settings", async (req, res) => {
    const patch = z.record(z.string(), z.string()).parse(req.body);
    // Provider configuration and keys are managed by the administrator, never by this endpoint.
    if (Object.keys(patch).some((key) => managedSettings.includes(key))) throw new HttpError(400, "MANAGED_SETTING");
    const state = await changeAccountData(res.locals.user.id, configKey, { config: {} }, (state) => ({ config: { ...userSettings(state.config), ...patch } }), "preferences");
    res.json(state.config);
});
businessRouter.get("/plugins", async (_req, res) => res.json(await readAccountData(res.locals.user.id, pluginKey, { plugins: [] })));
businessRouter.post("/plugins", async (req, res) => {
    const input = z.object({ id: z.string(), name: z.string(), version: z.string(), description: z.string().optional(), url: z.string(), source: z.string(), enabled: z.boolean(), local: z.boolean().optional(), official: z.boolean().optional(), installedAt: z.string().optional() }).strict().parse(req.body);
    const state = await changeAccountData(res.locals.user.id, pluginKey, { plugins: [] }, (state) => ({ plugins: [{ ...input, installedAt: state.plugins.find((item: any) => item.id === input.id)?.installedAt || new Date().toISOString() }, ...state.plugins.filter((item: any) => item.id !== input.id)] }));
    res.json(state);
});
businessRouter.patch("/plugins/:id", async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await changeAccountData(res.locals.user.id, pluginKey, { plugins: [] }, (state) => ({ plugins: state.plugins.map((item: any) => item.id === req.params.id ? { ...item, enabled } : item) })));
});
businessRouter.delete("/plugins/:id", async (req, res) => res.json(await changeAccountData(res.locals.user.id, pluginKey, { plugins: [] }, (state) => ({ plugins: state.plugins.filter((item: any) => item.id !== req.params.id) }))));
businessRouter.post("/files/cleanup", async (_req, res) => { await cleanupAccountFiles(res.locals.user.id); res.json({ ok: true }); });
businessRouter.get("/assets/export", async (_req, res) => {
    const assets = await readAssets(res.locals.user.id);
    const files: any[] = [];
    const { rows } = await db.query("SELECT * FROM files WHERE user_id=$1", [res.locals.user.id]);
    for (const key of fileReferences(assets)) {
        const file = rows.find((item) => item.key === key);
        if (!file) throw new HttpError(409, "FILE_NOT_SYNCED");
        if (files.some((item) => item.storageKey === file.key)) continue;
        files.push({ storageKey: file.key, path: `files/${encodeURIComponent(file.key)}.${file.mime_type.split("/")[1].split("+")[0]}`, mimeType: file.mime_type, bytes: Number(file.bytes), diskId: file.disk_id });
    }
    res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", 'attachment; filename="creativeone-assets.zip"');
    const zip = new Zip((error, bytes, final) => { if (error) res.destroy(error); else { res.write(bytes); if (final) res.end(); } });
    const disconnect = new AbortController();
    const onClose = () => disconnect.abort(); res.once("close", onClose);
    try {
        for (const file of files) {
            if (res.destroyed) return;
            const entry = new ZipPassThrough(file.path); zip.add(entry);
            for await (const chunk of createReadStream(resolve(env.MEDIA_DIR, file.diskId))) {
                if (res.destroyed) return;
                entry.push(chunk);
                if (res.writableNeedDrain) await once(res, "drain", { signal: disconnect.signal });
            }
            entry.push(new Uint8Array(), true);
        }
        const manifest = new ZipPassThrough("assets.json"); zip.add(manifest);
        manifest.push(new TextEncoder().encode(JSON.stringify({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files: files.map(({ diskId, ...file }) => file) })), true);
        zip.end();
    } finally { res.off("close", onClose); zip.terminate(); }
});

businessRouter.get("/works", async (req, res) => {
    const query = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().positive().default(10), view: z.enum(["works", "tasks"]).default("works"), kind: z.string().default("all"), status: z.string().default("all"), source: z.string().default("all"), keyword: z.string().default("") }).parse(req.query);
    const assets = await readAssets(res.locals.user.id);
    const { rows } = await db.query("SELECT id,channel_id,upstream_id,model,capability,path,status,result,error,request,created_at,updated_at FROM generation_tasks WHERE user_id=$1 AND NOT hidden_from_works ORDER BY created_at DESC", [res.locals.user.id]);
    const tasks = rows.map((task) => ({ ...task, created_at: task.created_at.toISOString(), error_message: task.error ? modelErrorMessage(task.error) : undefined }));
    const activeTasks = tasks.filter((task) => ["pending", "running"].includes(task.status)).map(({id,status}) => ({ id, status }));
    const works = mergeWorks(assets, tasks).filter((work) => (query.view === "tasks" ? Boolean(work.task) : work.state === "completed")
        && (query.kind === "all" || work.kind === query.kind)
        && (query.view !== "tasks" || query.status === "all" || (query.status === "processing" ? work.state === "processing" : work.task?.status === query.status))
        && (query.view === "tasks" || query.source === "all" || work.source === query.source)
        && (!query.keyword || workSearchText(work).includes(query.keyword.toLowerCase())));
    res.json({ works: works.slice((query.page-1)*query.pageSize,query.page*query.pageSize), total: works.length, activeTasks });
});
