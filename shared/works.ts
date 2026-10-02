import type { Asset } from "../web/src/stores/use-asset-store";
import type { Task } from "../web/src/services/api/tasks";
import { generationPrompt } from "./generation-request.js";

export type WorkKind = "text" | "image" | "video" | "audio";
export type WorkState = "processing" | "completed" | "attention";
export type Work = { id: string; kind: WorkKind; state: WorkState; source: "generated" | "uploaded"; createdAt: string; asset?: Asset; task?: Task; assets: Asset[] };
export type WorkMedia = { url: string; storageKey?: string; width?: number; height?: number };
export const workKinds: Record<WorkKind, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };
export const taskLabels: Record<string, string> = { running: "生成中", pending: "生成中", succeeded: "已完成", failed: "生成失败", unknown: "需处理", cancelled: "已取消", expired: "已过期" };

export function taskMedia(task: Task): WorkMedia[] {
    const result = task.result?.data && !Array.isArray(task.result.data) ? task.result.data : task.result;
    if (task.capability === "video") {
        const url = result?.file?.url || (task.path === "videos" ? result?.metadata?.url : result?.content?.video_url) || result?.url;
        return url ? [{ ...result?.file, url }] : [];
    }
    if (task.capability === "image" && Array.isArray(result?.data)) return result.data.filter((item): item is { url: string } => Boolean(item.url));
    return result?.url ? [{ url: result.url }] : [];
}

export function assetMedia(asset: Asset): WorkMedia[] {
    return asset.kind === "text" ? [] : [{ ...asset.data, url: asset.kind === "image" ? asset.data.dataUrl : asset.data.url }];
}

// Only exact file references or explicit task IDs establish a relationship.
export function mergeWorks(assets: Asset[], tasks: Task[]): Work[] {
    const byUrl = new Map<string, Task>();
    const byKey = new Map<string, Task>();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) for (const media of taskMedia(task)) {
        byUrl.set(media.url, task);
        if (media.storageKey) byKey.set(media.storageKey, task);
    }
    const linked = new Map<string, Asset[]>();
    const standalone: Work[] = [];
    for (const asset of assets) {
        const media = assetMedia(asset)[0];
        const task = byId.get(String(asset.metadata?.taskId || "")) || byUrl.get(String(asset.metadata?.sourceUrl || "")) || (media?.storageKey ? byKey.get(media.storageKey) : undefined) || (media ? byUrl.get(media.url) : undefined);
        if (task) linked.set(task.id, [...(linked.get(task.id) || []), asset]);
        else standalone.push({ id: `asset:${asset.id}`, kind: asset.kind, state: "completed", source: ["image-page", "video-page"].includes(String(asset.metadata?.source)) ? "generated" : "uploaded", createdAt: asset.createdAt, asset, assets: [asset] });
    }
    return [...standalone, ...tasks.map((task): Work => ({ id: `task:${task.id}`, kind: task.capability as WorkKind, state: task.status === "succeeded" ? "completed" : ["running", "pending"].includes(task.status) ? "processing" : "attention", source: "generated", createdAt: task.created_at, task, assets: linked.get(task.id) || [] }))].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function workSearchText(work: Work) {
    return [work.task?.model, generationPrompt(work.task?.request), work.task?.id, work.task?.error_message, work.task?.result?.text, ...work.assets.flatMap((asset) => [asset.title, asset.source, asset.note, ...asset.tags, asset.kind === "text" ? asset.data.content : ""])].join(" ").toLowerCase();
}
