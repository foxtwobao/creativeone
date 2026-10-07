import type { PoolClient } from "pg";
import { db, transaction } from "./db.js";
import { modelErrorMessage } from "./model-errors.js";
import type { CanvasNodeData } from "../../web/src/types/canvas.js";

export async function attachCanvasTask(taskId: string, client: Pick<PoolClient, "query">) {
    const task = (await client.query("SELECT * FROM generation_tasks WHERE id=$1", [taskId])).rows[0];
    if (!task?.canvas_project_id || !task.canvas_generation_id || task.canvas_attached) return;
    const project = (await client.query("SELECT nodes FROM canvas_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE", [task.canvas_project_id, task.user_id])).rows[0];
    const nodes: CanvasNodeData[] = project?.nodes || [];
    const node = nodes.find((item) => item.id === task.canvas_node_id);
    const slot = task.canvas_output_id ? node?.metadata?.images?.find((image) => image.id === task.canvas_output_id) : node?.metadata;
    if (!slot || slot.generationId !== task.canvas_generation_id) {
        await client.query("UPDATE generation_tasks SET canvas_attached=true WHERE id=$1", [taskId]);
        return;
    }
    const file = task.capability === "image" ? task.result?.data?.[0]?.file : task.result?.file;
    const active = ["running", "pending"].includes(task.status);
    const succeeded = task.status === "succeeded" && file?.url && file?.storageKey;
    const errorDetails = succeeded || active ? undefined : modelErrorMessage(task.error) || (task.status === "unknown" ? "任务结果尚未确认，请查看生成任务；请勿重复提交。" : "生成失败，请查看生成任务详情。");
    const result = { ...slot, generationTaskId: taskId, status: active ? "loading" as const : succeeded ? "success" as const : "error" as const, errorDetails,
        ...(task.capability === "video" && task.upstream_id ? { videoTaskId: task.upstream_id, videoTaskProvider: task.path === "videos" ? "wan" as const : "seedance" as const, videoTaskModel: `${task.channel_id}::${task.model}` } : {}),
        ...(succeeded ? { content: file.url, storageKey: file.storageKey, naturalWidth: file.width, naturalHeight: file.height, bytes: file.bytes, mimeType: file.mimeType, ...(file.durationMs === undefined ? {} : { durationMs: file.durationMs }) } : {}) };
    const metadata = { ...node!.metadata };
    if (task.canvas_output_id) {
        metadata.images = metadata.images!.map((image) => image.id === task.canvas_output_id ? { ...image, ...result } : image);
        const primary = metadata.images.find((image) => image.id === metadata.primaryImageId && image.status === "success" && image.content) || metadata.images.find((image) => image.status === "success" && image.content);
        if (primary) Object.assign(metadata, { content: primary.content, storageKey: primary.storageKey, naturalWidth: primary.naturalWidth, naturalHeight: primary.naturalHeight, bytes: primary.bytes, mimeType: primary.mimeType, primaryImageId: primary.id });
        metadata.status = metadata.images.some((image) => image.status === "loading") ? "loading" : primary ? "success" : "error";
        metadata.errorDetails = primary ? undefined : errorDetails;
    } else Object.assign(metadata, result);
    // Preserve geometry, title, prompt and all edits made after the request was accepted.
    if (JSON.stringify(metadata) !== JSON.stringify(node!.metadata)) await client.query("UPDATE canvas_projects SET nodes=$3,content_revision=content_revision+1,generation_revision=generation_revision+1,updated_at=now() WHERE id=$1 AND user_id=$2", [task.canvas_project_id, task.user_id, JSON.stringify(nodes.map((item) => item.id === node!.id ? { ...item, metadata } : item))]);
    if (!active) await client.query("UPDATE generation_tasks SET canvas_attached=true WHERE id=$1", [taskId]);
}

export async function finishCanvasTask(taskId: string) {
    await transaction(async (client) => {
        const task = (await client.query("SELECT user_id FROM generation_tasks WHERE id=$1 AND canvas_project_id IS NOT NULL", [taskId])).rows[0];
        if (!task) return;
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [task.user_id]);
        await client.query("SELECT id FROM generation_tasks WHERE id=$1 FOR UPDATE", [taskId]);
        await attachCanvasTask(taskId, client);
    });
}

export async function recoverCanvasResults(userId: string, projectId: string) {
    const { rows } = await db.query("SELECT id FROM generation_tasks WHERE user_id=$1 AND canvas_project_id=$2 AND canvas_generation_id IS NOT NULL AND NOT canvas_attached AND status IN ('succeeded','failed','unknown') ORDER BY created_at", [userId, projectId]);
    for (const task of rows) await finishCanvasTask(task.id);
}

export async function recoverUnacceptedCanvasSlots(userId: string, projectId: string) {
    await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const project = (await client.query("SELECT nodes FROM canvas_projects WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [userId, projectId])).rows[0];
        if (!project) return;
        const tasks = (await client.query("SELECT canvas_generation_id FROM generation_tasks WHERE user_id=$1 AND canvas_project_id=$2", [userId, projectId])).rows;
        const accepted = new Set(tasks.map((task) => task.canvas_generation_id));
        let changed = false;
        const nodes = (project.nodes as CanvasNodeData[]).map((node) => {
            if (!node.metadata) return node;
            const fail = <T extends { generationId?: string; status?: string; errorDetails?: string }>(slot: T): T => {
                if (slot.status !== "loading" || !slot.generationId || accepted.has(slot.generationId)) return slot;
                changed = true; return { ...slot, status: "error", errorDetails: "这次生成尚未受理，请手动重新生成。" };
            };
            const metadata = fail(node.metadata);
            const images = metadata.images?.map(fail);
            if (images?.some((image, index) => image !== metadata.images![index])) return { ...node, metadata: { ...metadata, images, status: images.some((image) => image.status === "loading") ? "loading" : images.some((image) => image.status === "success") ? "success" : "error" } };
            return metadata === node.metadata ? node : { ...node, metadata };
        });
        if (changed) await client.query("UPDATE canvas_projects SET nodes=$3,content_revision=content_revision+1,generation_revision=generation_revision+1,updated_at=now() WHERE user_id=$1 AND id=$2", [userId, projectId, JSON.stringify(nodes)]);
    });
}
