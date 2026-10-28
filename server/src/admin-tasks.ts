import { Router } from "express";
import { z } from "zod";
import { adminSubjects } from "./config.js";
import { db } from "./db.js";
import { requireAdmin } from "./auth.js";
import { HttpError, requireUuid } from "./http.js";
import { sendStoredFile } from "./storage.js";
import { modelErrorMessage } from "./model-errors.js";
import { generationPrompt, generationRequestPrompt } from "../../shared/generation-request.js";
import { taskParameterKeys, taskSettings } from "../../shared/task-settings.js";
import type { AdminTask, AdminTaskMedia } from "../../shared/admin-tasks.js";

export const adminTasksRouter = Router();
adminTasksRouter.use("/admin/users", requireAdmin);
adminTasksRouter.use("/admin/tasks", requireAdmin);
const audience = { userId: z.uuid().optional(), includeAdmins: z.enum(["true", "false"]).default("false").transform(value => value === "true") };
const pagination = { page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().positive().default(10) };
const userColumns = "u.id AS owner_id,u.username,u.display_name,u.email";
const userSummary = (row: any) => ({ id: row.owner_id || row.id, username: row.username, displayName: row.display_name, email: row.email });
function taskSummary(row: any): AdminTask {
    return { id: row.id, user: userSummary(row), capability: row.capability, model: row.model, status: row.status,
        source: row.canvas_generation_id || row.canvas_project_id ? "canvas" : "workbench", prompt: generationPrompt(row.request),
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        hiddenFromWorks: row.hidden_from_works, hiddenFromHistory: row.hidden_from_history };
}
adminTasksRouter.get("/admin/users", async (req, res) => {
    const { keyword, page, pageSize } = z.object({ ...pagination, keyword: z.string().default("") }).parse(req.query);
    const where = "($1='' OR username ILIKE '%'||$1||'%' OR display_name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR id::text=$1)";
    const [users, count] = await Promise.all([
        db.query(`SELECT id,username,display_name,email FROM users WHERE ${where} ORDER BY username,id LIMIT $2 OFFSET $3`, [keyword, pageSize, (page-1)*pageSize]),
        db.query(`SELECT count(*) FROM users WHERE ${where}`, [keyword]),
    ]);
    res.json({ users: users.rows.map(userSummary), total: Number(count.rows[0].count) });
});
adminTasksRouter.get("/admin/tasks", async (req, res) => {
    const query = z.object({ ...pagination, ...audience, from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
        capability: z.enum(["image", "video", "audio"]).optional(), status: z.enum(["pending", "running", "succeeded", "failed", "unknown", "cancelled", "expired"]).optional(), taskId: z.string().default("") }).parse(req.query);
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new HttpError(400, "INVALID_REQUEST");
    const params = [query.userId || null, query.from || null, query.to || null, query.capability || null, query.status || null, query.taskId, query.includeAdmins, [...adminSubjects]];
    const where = `t.capability IN ('image','video','audio') AND ($1::uuid IS NULL OR t.user_id=$1) AND ($2::timestamptz IS NULL OR t.created_at >= $2)
        AND ($3::timestamptz IS NULL OR t.created_at < $3) AND ($4::text IS NULL OR t.capability=$4) AND ($5::text IS NULL OR t.status=$5)
        AND ($6='' OR t.id::text=$6 OR t.upstream_id=$6) AND ($7::boolean OR NOT (u.subject=ANY($8::text[])))`;
    const [tasks, count] = await Promise.all([
        db.query(`SELECT t.id,t.capability,t.model,t.status,t.canvas_project_id,t.canvas_generation_id,t.created_at,t.updated_at,t.hidden_from_works,t.hidden_from_history,
            jsonb_build_object('prompt',t.request->'prompt','user_prompt',t.request->'user_prompt','content',t.request->'content','audio_input',t.request->'audio_input') AS request,${userColumns}
            FROM generation_tasks t JOIN users u ON u.id=t.user_id WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT $9 OFFSET $10`, [...params, query.pageSize, (query.page-1)*query.pageSize]),
        db.query(`SELECT count(*) FROM generation_tasks t JOIN users u ON u.id=t.user_id WHERE ${where}`, params),
    ]);
    res.json({ tasks: tasks.rows.map((row) => ({ ...taskSummary(row), prompt: generationPrompt(row.request).slice(0, 120) })), total: Number(count.rows[0].count) });
});
adminTasksRouter.get("/admin/tasks/stats", async (req, res) => {
    const query = z.object(audience).parse(req.query);
    const { rows } = await db.query(`WITH bounds AS (
        SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AS today
    ), periods AS (
        SELECT 'today' AS period, today AT TIME ZONE 'Asia/Shanghai' AS start_at, (today + interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS end_at, 1 AS position FROM bounds
        UNION ALL SELECT 'yesterday', (today - interval '1 day') AT TIME ZONE 'Asia/Shanghai', today AT TIME ZONE 'Asia/Shanghai', 2 FROM bounds
        UNION ALL SELECT 'week', (today - interval '6 days') AT TIME ZONE 'Asia/Shanghai', (today + interval '1 day') AT TIME ZONE 'Asia/Shanghai', 3 FROM bounds
    ), tasks AS (
        SELECT t.capability,t.status,t.created_at FROM generation_tasks t JOIN users u ON u.id=t.user_id
        WHERE t.capability IN ('image','video','audio') AND ($1::uuid IS NULL OR t.user_id=$1)
            AND ($2::boolean OR NOT (u.subject=ANY($3::text[])))
            AND t.created_at >= (SELECT min(start_at) FROM periods) AND t.created_at < (SELECT max(end_at) FROM periods)
    ) SELECT p.period, count(*) FILTER (WHERE t.capability='image') AS images,
        count(*) FILTER (WHERE t.capability='video') AS videos, count(*) FILTER (WHERE t.capability='audio') AS audios, count(*) FILTER (WHERE t.status='succeeded') AS succeeded,
        count(*) FILTER (WHERE t.status='failed') AS failed
        FROM periods p LEFT JOIN tasks t ON t.created_at >= p.start_at AND t.created_at < p.end_at
        GROUP BY p.period,p.position ORDER BY p.position`, [query.userId || null, query.includeAdmins, [...adminSubjects]]);
    res.json({ stats: rows.map(row => ({ period: row.period, images: Number(row.images), videos: Number(row.videos), audios: Number(row.audios), succeeded: Number(row.succeeded), failed: Number(row.failed) })) });
});
adminTasksRouter.get("/admin/tasks/:id", async (req, res) => {
    const { rows } = await db.query(`SELECT t.id,t.user_id,t.capability,t.model,t.status,t.canvas_project_id,t.canvas_generation_id,t.created_at,t.updated_at,t.hidden_from_works,t.hidden_from_history,
        t.request,t.result,t.error,t.upstream_error,t.upstream_id,p.title AS canvas_title,${userColumns}
        FROM generation_tasks t JOIN users u ON u.id=t.user_id LEFT JOIN canvas_projects p ON p.id=t.canvas_project_id AND p.user_id=t.user_id
        WHERE t.id=$1 AND t.capability IN ('image','video','audio')`, [requireUuid(req.params.id)]);
    const task = rows[0];
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND");
    const request = task.request || {};
    const refs: { kind: AdminTaskMedia["kind"]; url: unknown }[] = [];
    const imageRefs = request.image_references || request.image_urls || request.images || (request.image ? [request.image] : []);
    for (const ref of imageRefs) refs.push({ kind: "image", url: typeof ref === "string" ? ref : ref.url });
    for (const kind of ["image", "video", "audio"] as const) {
        for (const ref of request[`reference_${kind}s`] || []) refs.push({ kind, url: ref.url });
        for (const part of request.content || []) if (part.type === `${kind}_url`) refs.push({ kind, url: part[`${kind}_url`]?.url });
    }
    const result = task.result?.data && !Array.isArray(task.result.data) ? task.result.data : task.result;
    const videoUrl = result?.file?.url || result?.metadata?.url || result?.content?.video_url || result?.url;
    const outputs = task.capability === "image" ? (result?.data || []).map((item: any) => ({ kind: "image" as const, url: item.file?.url || item.url }))
        : task.capability === "audio" ? (result?.audios || []).flatMap((item: any) => item.file ? [{ kind: "audio" as const, url: item.file.url }] : []) : videoUrl ? [{ kind: "video" as const, url: videoUrl }] : [];
    const localFile = (url: unknown) => typeof url === "string" ? /^\/api\/files\/(image_files|media_files)\/([^/?#]+)$/.exec(url) : null;
    const keys = [...refs, ...outputs].flatMap((item) => { const match = localFile(item.url); return match ? [decodeURIComponent(match[2])] : []; });
    const files = (await db.query("SELECT namespace,key FROM files WHERE user_id=$1 AND key=ANY($2::text[])", [task.user_id, keys])).rows;
    function media(item: { kind: AdminTaskMedia["kind"]; url: unknown }): AdminTaskMedia {
        const match = localFile(item.url);
        if (!match) return { kind: item.kind };
        const key = decodeURIComponent(match[2]);
        if (!files.some((file) => file.namespace === match[1] && file.key === key)) return { kind: item.kind };
        const url = `/api/admin/users/${task.user_id}/files/${match[1]}/${encodeURIComponent(key)}`;
        return { kind: item.kind, url, ...(item.kind === "image" ? { previewUrl: `${url}?preview=1` } : {}) };
    }
    const parameters = Object.fromEntries(taskParameterKeys.filter((key) => key in request).map((key) => [key, request[key]]));
    const error = task.error || (task.status === "failed" ? "TOKENONE_GENERATION_FAILED" : null);
    res.json({ task: { ...taskSummary(task), upstreamId: task.upstream_id, canvasTitle: task.canvas_title || null,
        prompt: generationPrompt(request), sentPrompt: generationRequestPrompt(request), settings: taskSettings({ ...parameters, audio_input: request.audio_input }),
        error: task.upstream_error ? task.upstream_error.code || (task.upstream_error.status ? `HTTP ${task.upstream_error.status}` : "UPSTREAM_ERROR") : (error?.startsWith("TOKENONE_HTTP_") ? "UPSTREAM_ERROR_DETAILS_UNAVAILABLE" : error),
        errorMessage: task.upstream_error?.message || (error?.startsWith("TOKENONE_HTTP_") ? "此任务未保存上游错误详情，无法还原具体原因。" : error ? modelErrorMessage(error) || error : null),
        references: refs.map(media), results: outputs.map(media) } });
});
adminTasksRouter.get("/admin/users/:userId/files/:namespace/:key", async (req, res) => {
    await sendStoredFile(res, requireUuid(req.params.userId), req.params.namespace, req.params.key, req.query.preview === "1");
});
