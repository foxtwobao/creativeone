import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { HttpError, requireUuid } from "./http.js";
import { readAccountData, changeAccountData, cleanupAccountFiles } from "./account-data.js";
import { mergeWorks, workSearchText } from "../../shared/works.js";
import { modelErrorMessage } from "./model-errors.js";
import { readAssets, fileReferences } from "./storage.js";
import { attachCanvasTask, recoverCanvasResults, recoverUnacceptedCanvasSlots } from "./canvas-tasks.js";
import { canvasGraphView, persistCanvasGraph } from "./canvas-graph.js";
import { canvasArchiveMediaValid, remapCanvasGraph } from "../../shared/canvas-archive.js";
import { canvasEditableNode, preserveCanvasGeneration } from "../../shared/canvas-generations.js";
import type { CanvasNodeData } from "../../web/src/types/canvas.js";

export const businessRouter = Router();
const configKey = "infinite-canvas:ai_config_store", pluginKey = "infinite-canvas:plugin_store";
const generationFields = { generationId: z.string().min(1).optional(), generationTaskId: z.string().min(1).optional(), status: z.enum(["idle", "loading", "success", "error"]).optional() };
const canvasMetadata = z.object({ ...generationFields,
    prompt: z.string().optional(), composerContent: z.string().optional(), content: z.string().optional(), model: z.string().optional(),
    size: z.string().optional(), videoSize: z.string().optional(), quality: z.string().optional(), background: z.string().optional(), seconds: z.string().optional(), vquality: z.string().optional(),
    generateAudio: z.string().optional(), watermark: z.string().optional(), videoMode: z.string().optional(), generationMode: z.enum(["image", "video", "text", "audio"]).optional(),
    groupId: z.string().optional(), storageKey: z.string().optional(), mimeType: z.string().optional(), references: z.array(z.string()).optional(), freeResize: z.boolean().optional(),
    naturalWidth: z.number().finite().nonnegative().optional(), naturalHeight: z.number().finite().nonnegative().optional(), durationMs: z.number().finite().nonnegative().optional(), bytes: z.number().finite().nonnegative().optional(),
    texts: z.array(z.object({ id: z.string().min(1), content: z.string().optional(), ...generationFields }).passthrough()).optional(),
    images: z.array(z.object({ id: z.string().min(1), ...generationFields, content: z.string().optional(), storageKey: z.string().optional(), naturalWidth: z.number().finite().nonnegative().optional(), naturalHeight: z.number().finite().nonnegative().optional(), bytes: z.number().finite().nonnegative().optional(), mimeType: z.string().optional() }).passthrough()).optional() }).passthrough();
const canvasNode = z.object({ id: z.string().min(1), type: z.string().min(1), title: z.string(), position: z.object({ x: z.number().finite(), y: z.number().finite() }), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(), metadata: canvasMetadata.optional() }).passthrough();
const canvasConnection = z.object({ id: z.string().min(1), fromNodeId: z.string().min(1), toNodeId: z.string().min(1) }).passthrough();
const canvasGraphEdit = z.discriminatedUnion("type", [
    z.object({ type: z.literal("put_node"), node: canvasNode, replaceResult: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("delete_node"), id: z.string().min(1) }).strict(),
    z.object({ type: z.literal("put_connection"), connection: canvasConnection }).strict(),
    z.object({ type: z.literal("delete_connection"), id: z.string().min(1) }).strict(),
]);
const projectFields = z.object({ title: z.string().trim().min(1), nodes: z.array(canvasNode), connections: z.array(canvasConnection), chatSessions: z.array(z.unknown()), activeChatId: z.string().nullable(), backgroundMode: z.enum(["lines", "dots", "blank"]), showImageInfo: z.boolean(), viewport: z.object({ x: z.number().finite(), y: z.number().finite(), k: z.number().finite().positive() }) });
const projectPatch = projectFields.partial().strict();
const projectDefaults = { title: "未命名画布", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
const editCommand = z.object({ type: z.literal("edit_project"), patch: projectPatch.omit({ nodes: true, connections: true }).default({}), graphEdits: z.array(canvasGraphEdit).default([]) }).strict();
const commandInput = z.object({ operationId: z.string().trim().min(1).max(200), baseRevision: z.coerce.number().int().positive(), baseGenerationRevision: z.number().int().nonnegative().default(0), command: z.discriminatedUnion("type", [editCommand, z.object({ type: z.literal("restore_edit"), sourceOperationId: z.string().min(1), direction: z.enum(["undo", "redo"]) }).strict()]) }).strict();
function stripCanvasTaskIds(node: z.infer<typeof canvasNode>): CanvasNodeData {
    const metadata = node.metadata as CanvasNodeData["metadata"];
    return { ...node, ...(metadata ? { metadata: { ...metadata, generationTaskId: undefined, ...(Array.isArray(metadata.images) ? { images: metadata.images.map((image) => ({ ...image, generationTaskId: undefined })) } : {}) } } : {}) } as CanvasNodeData;
}

function canvasProject(row: any) {
    return {
        id: row.id, title: row.title, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        nodes: row.nodes, connections: row.connections, chatSessions: row.chat_sessions, activeChatId: row.active_chat_id,
        backgroundMode: row.background_mode, showImageInfo: row.show_image_info, viewport: row.viewport,
        contentRevision: Number(row.content_revision),
        generationRevision: Number(row.generation_revision),
    };
}
async function findCanvasProject(userId: string, id: string, client: Pick<typeof db, "query"> = db, lock = false) {
    const { rows } = await client.query(`SELECT * FROM canvas_projects WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [userId, id]);
    if (!rows[0]) throw new HttpError(404, "PROJECT_NOT_FOUND");
    return { ...rows[0], ...canvasGraphView(rows[0].nodes, rows[0].connections) };
}
async function assertCanvasFiles(userId: string, value: unknown, client: Pick<typeof db, "query">) {
    const references = [...fileReferences(value)];
    if (!references.length) return;
    const { rows } = await client.query("SELECT key FROM files WHERE user_id=$1 AND key=ANY($2::text[])", [userId, references]);
    if (rows.length !== references.length) throw new HttpError(409, "FILE_NOT_SYNCED");
}
function validateCanvasGraph(nodes: unknown[], connections: unknown[]) {
    const nodeIds = new Set(nodes.map((node) => (node as { id: string }).id));
    if (nodeIds.size !== nodes.length) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
    if (new Set(connections.map((connection) => (connection as { id: string }).id)).size !== connections.length) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
    const groups = new Map((nodes as CanvasNodeData[]).map((node) => [node.id, node]));
    for (const node of nodes as CanvasNodeData[]) {
        const ancestors = new Set([node.id]);
        let parent = node.metadata?.groupId;
        while (parent) {
            if (ancestors.has(parent) || groups.get(parent)?.type !== "group") throw new HttpError(400, "INVALID_CANVAS_GRAPH");
            ancestors.add(parent); parent = groups.get(parent)?.metadata?.groupId;
        }
        if (new Set(node.metadata?.images?.map((image) => image.id)).size !== (node.metadata?.images?.length || 0)) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
        if (new Set(node.metadata?.texts?.map((text) => text.id)).size !== (node.metadata?.texts?.length || 0)) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
    }
    const edges = new Set<string>();
    for (const connection of connections as Array<{ id: string; fromNodeId: string; toNodeId: string }>) {
        if (!nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId) || connection.fromNodeId === connection.toNodeId) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
        const edge = `${connection.fromNodeId}\u0000${connection.toNodeId}`;
        if (edges.has(edge)) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
        edges.add(edge);
    }
}
businessRouter.get("/projects", async (_req, res) => {
    const userId = res.locals.user.id;
    const { rows } = await db.query('SELECT id,title,created_at,updated_at,content_revision,generation_revision,jsonb_array_length(nodes) AS node_count,jsonb_array_length(connections) AS connection_count FROM canvas_projects WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC', [userId]);
    const deleted = await db.query("SELECT id,deleted_at FROM canvas_projects WHERE user_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", [userId]);
    res.json({ projects: rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), nodeCount: row.node_count, connectionCount: row.connection_count, contentRevision: Number(row.content_revision), generationRevision: Number(row.generation_revision) })), deletedProjects: deleted.rows.map((row) => ({ id: row.id, deletedAt: row.deleted_at.toISOString() })) });
});
businessRouter.get("/projects/:id", async (req, res) => {
    const id = requireUuid(req.params.id), userId = res.locals.user.id;
    await findCanvasProject(userId, id);
    await recoverCanvasResults(userId, id);
    await recoverUnacceptedCanvasSlots(userId, id);
    res.json({ project: canvasProject(await findCanvasProject(userId, id)) });
});
businessRouter.get("/projects/:id/task-status", async (req, res) => {
    const id = requireUuid(req.params.id), userId = res.locals.user.id;
    const project = (await db.query(`SELECT content_revision,ARRAY(
        SELECT node->'metadata'->>'generationId' FROM jsonb_array_elements(nodes) node WHERE node->'metadata'->>'generationId' IS NOT NULL
        UNION SELECT image->>'generationId' FROM jsonb_array_elements(nodes) node CROSS JOIN LATERAL jsonb_array_elements(COALESCE(node->'metadata'->'images','[]'::jsonb)) image WHERE image->>'generationId' IS NOT NULL
    ) AS operations FROM canvas_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, userId])).rows[0];
    if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND");
    const operations: string[] = project.operations;
    const { rows } = await db.query('SELECT id,status,canvas_generation_id AS "generationId" FROM generation_tasks WHERE user_id=$1 AND canvas_project_id=$2 AND canvas_generation_id=ANY($3::text[])', [userId, id, operations]);
    res.json({ contentRevision: Number(project.content_revision), tasks: [...rows, ...operations.filter((operation: string) => !rows.some((task) => task.generationId === operation)).map((generationId: string) => ({ generationId, status: "not_accepted" }))] });
});
businessRouter.post("/projects/archive/validate", async (req, res) => {
    const archive = z.object({ app: z.literal("infinite-canvas"), version: z.literal(4), exportedAt: z.string(), projects: z.array(z.object({ project: projectFields.pick({ title: true, nodes: true, connections: true, backgroundMode: true, showImageInfo: true, viewport: true }).strict(), files: z.array(z.object({ storageKey: z.string().min(1), path: z.string().min(1), mimeType: z.string().regex(/^(image|video|audio)\//), bytes: z.number().int().nonnegative() }).strict()) }).strict()) }).strict().parse(req.body);
    for (const item of archive.projects) {
        validateCanvasGraph(item.project.nodes, item.project.connections);
        if (!canvasArchiveMediaValid(item.project.nodes as CanvasNodeData[])) throw new HttpError(400, "INVALID_CANVAS_ARCHIVE");
        const keys = new Set(item.files.map((file) => file.storageKey));
        if (keys.size !== item.files.length || [...fileReferences(item.project)].some((key) => !keys.has(key))) throw new HttpError(400, "INVALID_CANVAS_ARCHIVE");
    }
    res.json(archive);
});
businessRouter.post("/projects", async (req, res) => {
    const input = projectPatch.parse(req.body);
    const id = randomUUID();
    const now = new Date();
    validateCanvasGraph(input.nodes || [], input.connections || []);
    if (!canvasArchiveMediaValid((input.nodes || []) as CanvasNodeData[])) throw new HttpError(400, "INVALID_CANVAS_ARCHIVE");
    const project = { ...projectDefaults, ...input, ...remapCanvasGraph((input.nodes || []) as CanvasNodeData[], input.connections || [], randomUUID), chatSessions: [], activeChatId: null };
    validateCanvasGraph(project.nodes, project.connections);
    const persisted = persistCanvasGraph(project.nodes, project.connections, { nodes: [], connections: [] });
    await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [res.locals.user.id]);
        await assertCanvasFiles(res.locals.user.id, project, client);
        await client.query("INSERT INTO canvas_projects (id,user_id,title,nodes,connections,chat_sessions,active_chat_id,background_mode,show_image_info,viewport,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)", [id, res.locals.user.id, project.title, JSON.stringify(persisted.nodes), JSON.stringify(persisted.connections), JSON.stringify(project.chatSessions), project.activeChatId, project.backgroundMode, project.showImageInfo, JSON.stringify(project.viewport), now]);
    });
    const row = await findCanvasProject(res.locals.user.id, id);
    res.status(201).json({ project: canvasProject(row) });
});
businessRouter.post("/projects/:id/commands", async (req, res) => {
    const id = requireUuid(req.params.id), input = commandInput.parse(req.body), userId = res.locals.user.id;
    const result = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const project = await findCanvasProject(userId, id, client, true);
        const previous = await client.query("SELECT result,base_revision,base_generation_revision,command FROM canvas_project_commands WHERE project_id=$1 AND operation_id=$2", [id, input.operationId]);
        if (previous.rows[0]) {
            if (Number(previous.rows[0].base_revision) !== input.baseRevision || Number(previous.rows[0].base_generation_revision) !== input.baseGenerationRevision || !isDeepStrictEqual(previous.rows[0].command, input.command)) throw new HttpError(409, "PROJECT_OPERATION_CONFLICT");
            const receipt = previous.rows[0].result;
            if (Number(project.content_revision) - Number(project.generation_revision) !== receipt.contentRevision - receipt.generationRevision) throw new HttpError(409, "PROJECT_REVISION_CONFLICT");
            return canvasProject(project);
        }
        // Only worker result updates may advance the version without conflicting with an edit.
        if (input.baseRevision > Number(project.content_revision) || input.baseGenerationRevision > Number(project.generation_revision) || Number(project.content_revision) - Number(project.generation_revision) !== input.baseRevision - input.baseGenerationRevision) throw new HttpError(409, "PROJECT_REVISION_CONFLICT");
        let command = input.command.type === "edit_project" ? input.command : undefined;
        if (input.command.type === "restore_edit") {
            const source = (await client.query("SELECT inverse,undone FROM canvas_project_commands WHERE project_id=$1 AND operation_id=$2", [id, input.command.sourceOperationId])).rows[0];
            const undo = input.command.direction === "undo";
            if (!source?.inverse || Boolean(source.undone) === undo) throw new HttpError(409, "PROJECT_OPERATION_CONFLICT");
            const expected = source.inverse[undo ? "after" : "before"];
            for (const edit of expected.graphEdits) {
                if (edit.type === "put_node" || edit.type === "delete_node") {
                    const node = project.nodes.find((node: CanvasNodeData) => node.id === (edit.type === "put_node" ? edit.node.id : edit.id));
                    const comparable = edit.type === "put_node" && edit.node.metadata?.images && !edit.node.metadata.primaryImageId && node ? { ...node, metadata: { ...node.metadata, primaryImageId: undefined } } : node;
                    if (!isDeepStrictEqual(canvasEditableNode(comparable), edit.type === "put_node" ? canvasEditableNode(edit.node) : null)) throw new HttpError(409, "PROJECT_OPERATION_CONFLICT");
                } else {
                    const edge = project.connections.find((edge: { id: string }) => edge.id === (edit.type === "put_connection" ? edit.connection.id : edit.id));
                    if (edit.type === "put_connection" ? !edge || edge.fromNodeId !== edit.connection.fromNodeId || edge.toNodeId !== edit.connection.toNodeId : Boolean(edge)) throw new HttpError(409, "PROJECT_OPERATION_CONFLICT");
                }
            }
            for (const [key, value] of Object.entries(expected.patch)) if (!isDeepStrictEqual(canvasProject(project)[key as keyof ReturnType<typeof canvasProject>], value)) throw new HttpError(409, "PROJECT_OPERATION_CONFLICT");
            command = source.inverse[undo ? "before" : "after"];
            await client.query("UPDATE canvas_project_commands SET undone=$3 WHERE project_id=$1 AND operation_id=$2", [id, input.command.sourceOperationId, undo]);
        }
        const targets = command!.graphEdits.map((edit) => `${edit.type.endsWith("node") ? "node" : "connection"}:${edit.type === "put_node" ? edit.node.id : edit.type === "put_connection" ? edit.connection.id : edit.id}`);
        if (input.command.type === "edit_project" && new Set(targets).size !== targets.length) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
        const patch: Record<string, unknown> = { ...command!.patch };
        const nodes = new Map((project.nodes as Array<z.infer<typeof canvasNode>>).map((node) => [node.id, node]));
        const connections = new Map((project.connections as Array<z.infer<typeof canvasConnection>>).map((connection) => [connection.id, connection]));
        const deletedNodes = new Set<string>();
        for (const edit of command!.graphEdits) {
            if (edit.type === "put_node") {
                let incoming = stripCanvasTaskIds(edit.node);
                const old = nodes.get(edit.node.id) as CanvasNodeData | undefined;
                if (edit.replaceResult) {
                    if (!incoming.metadata?.storageKey || incoming.metadata.storageKey === old?.metadata?.storageKey) throw new HttpError(400, "INVALID_FILE_REFERENCE");
                    incoming = { ...incoming, metadata: { ...incoming.metadata, generationId: undefined, generationTaskId: undefined, images: undefined, primaryImageId: undefined } };
                }
                const markers = [incoming.metadata, ...incoming.metadata?.images || []].filter((slot) => slot?.status === "loading" && slot.generationId).map((slot) => slot!.generationId);
                const currentMarkers = new Set([old?.metadata?.generationId, ...old?.metadata?.images?.map((image) => image.generationId) || []]);
                const newMarkers = markers.filter((marker) => !currentMarkers.has(marker));
                if (input.command.type === "edit_project" && newMarkers.length && (await client.query("SELECT 1 FROM generation_tasks WHERE user_id=$1 AND canvas_project_id=$2 AND canvas_generation_id=ANY($3::text[])", [userId, id, newMarkers])).rowCount) throw new HttpError(409, "CANVAS_GENERATION_ALREADY_ACCEPTED");
                nodes.set(edit.node.id, preserveCanvasGeneration(incoming, edit.replaceResult ? undefined : old)); deletedNodes.delete(edit.node.id);
            }
            if (edit.type === "delete_node") { nodes.delete(edit.id); deletedNodes.add(edit.id); }
            if (edit.type === "put_connection") connections.set(edit.connection.id, edit.connection);
            if (edit.type === "delete_connection") connections.delete(edit.id);
        }
        const nextNodes = [...nodes.values()];
        if (command!.graphEdits.some((edit) => edit.type === "put_connection" && (deletedNodes.has(edit.connection.fromNodeId) || deletedNodes.has(edit.connection.toNodeId)))) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
        const nextConnections = [...connections.values()].filter((connection) => !deletedNodes.has(connection.fromNodeId) && !deletedNodes.has(connection.toNodeId));
        const implicitDeletedEdges = project.connections.filter((edge: { id: string }) => !connections.has(edge.id) || !nextConnections.some((item) => item.id === edge.id)).filter((edge: { id: string }) => !command!.graphEdits.some((edit) => edit.type === "put_connection" ? edit.connection.id === edge.id : edit.type === "delete_connection" && edit.id === edge.id));
        if (command!.graphEdits.some((edit) => edit.type === "put_node" || edit.type === "delete_node")) patch.nodes = nextNodes;
        if (command!.graphEdits.length) patch.connections = nextConnections;
        validateCanvasGraph(nextNodes, nextConnections);
        await assertCanvasFiles(userId, { nodes: nextNodes, connections: nextConnections, chatSessions: patch.chatSessions ?? project.chat_sessions }, client);
        const reversible = command!.graphEdits.length || Object.keys(patch).some((key) => ["title", "chatSessions", "activeChatId"].includes(key));
        const inverse = input.command.type === "edit_project" && reversible ? {
            before: { type: "edit_project", patch: Object.fromEntries(Object.keys(command!.patch).map((key) => [key, canvasProject(project)[key as keyof ReturnType<typeof canvasProject>]])), graphEdits: command!.graphEdits.map((edit) => {
                if (edit.type === "put_node" || edit.type === "delete_node") { const node = project.nodes.find((node: CanvasNodeData) => node.id === (edit.type === "put_node" ? edit.node.id : edit.id)); return node ? { type: "put_node", node } : { type: "delete_node", id: edit.type === "put_node" ? edit.node.id : edit.id }; }
                const connection = project.connections.find((edge: { id: string }) => edge.id === (edit.type === "put_connection" ? edit.connection.id : edit.id)); return connection ? { type: "put_connection", connection } : { type: "delete_connection", id: edit.type === "put_connection" ? edit.connection.id : edit.id };
            }).concat(implicitDeletedEdges.map((connection: unknown) => ({ type: "put_connection", connection }))) },
            after: command,
        } : null;
        const nextRevision = Number(project.content_revision) + (reversible ? 1 : 0);
        const columns: Record<string, string> = { title: "title", nodes: "nodes", connections: "connections", chatSessions: "chat_sessions", activeChatId: "active_chat_id", backgroundMode: "background_mode", showImageInfo: "show_image_info", viewport: "viewport" };
        const restoredEntities = input.command.type === "restore_edit" ? command!.graphEdits.flatMap((edit) => edit.type === "put_node" ? [edit.node] : []) : [];
        const previousNodes = project.nodes.map((node: CanvasNodeData) => {
            const restored = restoredEntities.find((item) => item.id === node.id);
            return restored ? { ...node, metadata: { ...node.metadata, images: [...restored.metadata?.images || [], ...node.metadata?.images || []], texts: [...restored.metadata?.texts || [], ...node.metadata?.texts || []] } } : node;
        });
        const restoredEdges = input.command.type === "restore_edit" ? command!.graphEdits.flatMap((edit) => edit.type === "put_connection" ? [edit.connection] : []) : [];
        const persisted = persistCanvasGraph(nextNodes as CanvasNodeData[], nextConnections, { nodes: [...restoredEntities as CanvasNodeData[], ...previousNodes], connections: [...project.connections, ...restoredEdges] });
        if (patch.nodes) patch.nodes = persisted.nodes;
        if (patch.connections) patch.connections = persisted.connections;
        const values: unknown[] = [nextRevision, id, userId];
        Object.entries(patch).forEach(([key, value]) => values.push(key === "activeChatId" || key === "title" || key === "backgroundMode" || key === "showImageInfo" ? value : JSON.stringify(value)));
        const assignmentSql = Object.entries(patch).map(([key], index) => `${columns[key]}=$${index + 4}`);
        await client.query(`UPDATE canvas_projects SET ${assignmentSql.join(",")}${assignmentSql.length ? "," : ""} content_revision=$1,updated_at=now() WHERE id=$2 AND user_id=$3`, values);
        if (input.command.type === "restore_edit") {
            const tasks = await client.query("UPDATE generation_tasks SET canvas_attached=false WHERE user_id=$1 AND canvas_project_id=$2 AND canvas_node_id=ANY($3::text[]) RETURNING id", [userId, id, persisted.nodes.map((node) => node.id)]);
            for (const task of tasks.rows) await attachCanvasTask(task.id, client);
        }
        const updated = canvasProject(await findCanvasProject(userId, id, client));
        const confirmedCommand = { ...command!, patch: Object.fromEntries(Object.keys(command!.patch).map((key) => [key, updated[key as keyof typeof updated]])), graphEdits: command!.graphEdits.map((edit) => edit.type === "put_node" ? { ...edit, node: updated.nodes.find((node: CanvasNodeData) => node.id === edit.node.id)! } : edit.type === "put_connection" ? { ...edit, connection: updated.connections.find((edge: { id: string }) => edge.id === edit.connection.id)! } : edit).concat(implicitDeletedEdges.map((edge: { id: string }) => ({ type: "delete_connection", id: edge.id }))) };
        if (inverse) inverse.after = confirmedCommand;
        if (input.command.type === "restore_edit") await client.query("UPDATE canvas_project_commands SET inverse=jsonb_set(inverse,$3::text[],$4::jsonb) WHERE project_id=$1 AND operation_id=$2", [id, input.command.sourceOperationId, [input.command.direction === "undo" ? "before" : "after"], JSON.stringify(confirmedCommand)]);
        await client.query("INSERT INTO canvas_project_commands (project_id,operation_id,base_revision,base_generation_revision,command,result,inverse) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, input.operationId, input.baseRevision, input.baseGenerationRevision, JSON.stringify(input.command), JSON.stringify({ contentRevision: updated.contentRevision, generationRevision: updated.generationRevision }), JSON.stringify(inverse)]);
        return updated;
    });
    res.json({ project: result });
});
businessRouter.delete("/projects/:id", async (req, res) => {
    const id = requireUuid(req.params.id), userId = res.locals.user.id;
    const result = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        return client.query("UPDATE canvas_projects SET deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", [id, userId]);
    });
    if (!result.rowCount) throw new HttpError(404, "PROJECT_NOT_FOUND");
    await cleanupAccountFiles(userId);
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
businessRouter.use("/plugins", (req, _res, next) => { if (req.method !== "GET") throw new HttpError(403, "CANVAS_PLUGINS_DISABLED"); next(); });
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
