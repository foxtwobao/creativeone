import type { NavigateFunction } from "react-router-dom";

import i18n from "@/i18n";
import { fetchPrompts } from "@/services/api/prompts";
import { uploadImage } from "@/services/image-storage";
import { imageSettingsForModel } from "@/lib/image-settings";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { inferVideoRatio, parseVideoResolution } from "@/lib/media-size";
import { videoSizeOptions, videoSettingsForModel } from "@/lib/video-settings";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { modelOptionLabel, modelOptionName, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

// Execute site-level Agent tools in the browser, including canvas lists, workbench generation, prompt search, and asset operations.
// Business data is saved to the server; tools access the current editor state through Zustand.

export const SITE_TOOL_NAMES = [
    "canvas_list_projects",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
] as const;

export type SiteToolName = (typeof SITE_TOOL_NAMES)[number];

export function isSiteTool(name: string): name is SiteToolName {
    return (SITE_TOOL_NAMES as readonly string[]).includes(name);
}

function siteText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.siteTools.${key}`, options);
}

export const SITE_TOOL_LABELS: Record<SiteToolName, string> = {
    get canvas_list_projects() { return siteText("canvasList"); },
    get generation_get_status() { return siteText("generationStatus"); },
    get workbench_image_get_config() { return siteText("imageConfig"); },
    get workbench_image_generate() { return siteText("imageGenerate"); },
    get workbench_video_get_config() { return siteText("videoConfig"); },
    get workbench_video_generate() { return siteText("videoGenerate"); },
    get prompts_search() { return siteText("promptSearch"); },
    get assets_list() { return siteText("assetList"); },
    get assets_add() { return siteText("assetAdd"); },
};

type SiteToolInput = Record<string, unknown>;
type SiteToolContext = { canvasSnapshot?: CanvasAgentSnapshot | null };
type GenerationStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "unknown";
type GenerationStatusItem = { id: string; source: "canvas" | "image" | "video"; status: GenerationStatus; kind?: string; title?: string; prompt?: string; projectId?: string; createdAt?: string; updatedAt?: string; successCount?: number; failCount?: number; error?: string };

export async function runSiteTool(name: SiteToolName, input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}): Promise<unknown> {
    switch (name) {
        case "canvas_list_projects":
            return listCanvasProjects(input);
        case "generation_get_status":
            return getGenerationStatus(input, context.canvasSnapshot);
        case "workbench_image_get_config":
            return getImageConfig();
        case "workbench_image_generate":
            return runImageWorkbench(input, navigate);
        case "workbench_video_get_config":
            return getVideoConfig();
        case "workbench_video_generate":
            return runVideoWorkbench(input, navigate);
        case "prompts_search":
            return searchPrompts(input);
        case "assets_list":
            return listAssets(input);
        case "assets_add":
            return addAsset(input);
        default:
            throw new Error(siteText("unknownTool", { name }));
    }
}

function getGenerationStatus(input: SiteToolInput, canvasSnapshot?: CanvasAgentSnapshot | null) {
    const scope = input.scope === "canvas" || input.scope === "image" || input.scope === "video" ? input.scope : "all";
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.filter((id): id is string => typeof id === "string") : []);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit)) || 20));
    const tasks: GenerationStatusItem[] = [];
    const includeCanvas = (scope === "all" || scope === "canvas") && (!taskId || nodeIds.size > 0);
    const includeWorkbench = !nodeIds.size || Boolean(taskId);

    if (includeCanvas && canvasSnapshot) {
        canvasSnapshot.nodes.forEach((node) => {
            const status = node.metadata?.videoTaskId && !node.metadata?.content && node.metadata?.status === "error" ? "unknown" : normalizeCanvasGenerationStatus(node.metadata?.status);
            if (!status || (nodeIds.size && !nodeIds.has(node.id))) return;
            const metadata = node.metadata || {};
            if (!nodeIds.size && node.type !== "config" && status !== "running" && status !== "failed" && !metadata.generationMode && !metadata.generationType && !metadata.model) return;
            tasks.push({ id: node.id, source: "canvas", status, kind: metadata.generationMode || node.type, title: node.title, prompt: compactPrompt(metadata.prompt || metadata.composerContent), projectId: canvasSnapshot.projectId, error: metadata.errorDetails });
        });
    }

    if (includeWorkbench) {
        useWorkbenchAgentStore.getState().tasks.forEach((task) => {
            if ((scope === "image" || scope === "video") && task.kind !== scope) return;
            if (scope === "canvas" || (taskId && task.id !== taskId)) return;
            tasks.push({ ...task, source: task.kind, prompt: compactPrompt(task.prompt) });
        });
    }

    tasks.sort((a, b) => generationStatusOrder(a.status) - generationStatusOrder(b.status) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const summary: Record<GenerationStatus, number> = { idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0 };
    tasks.forEach((task) => (summary[task.status] += 1));
    return { total: tasks.length, summary, tasks: tasks.slice(0, limit) };
}

function generationStatusOrder(status: GenerationStatus) {
    return status === "running" ? 0 : status === "queued" ? 1 : 2;
}

function normalizeCanvasGenerationStatus(status: unknown): GenerationStatus | null {
    if (status === "idle") return "idle";
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    return null;
}

function compactPrompt(prompt: unknown) {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    return value ? `${value.slice(0, 200)}${value.length > 200 ? "..." : ""}` : undefined;
}

function listCanvasProjects(input: SiteToolInput) {
    const { projects, hydrated } = useCanvasStore.getState();
    if (!hydrated) throw new Error(siteText("canvasLoading"));
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = keyword ? projects.filter((project) => project.title.toLowerCase().includes(keyword)) : projects;
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((project) => ({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodeCount: project.nodeCount,
        connectionCount: project.connectionCount,
    }));
    return { total: filtered.length, page, pageSize, items, hint: siteText("canvasHint") };
}

function getImageConfig() {
    const { config } = useConfigStore.getState();
    const model = config.imageModel || config.model;
    const settings = imageSettingsForModel(config, model);
    return {
        current: { model, modelName: modelOptionName(model), quality: settings.quality, size: settings.size, count: config.count || "1" },
        models: selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        qualityOptions: settings.qualities,
        scaleOptions: settings.scales,
        sizeOptions: settings.ratios,
        maxReferenceImages: settings.profile?.maxReferences ?? null,
        parameterError: settings.error,
        countRange: { min: 1, max: 15 },
    };
}

function runImageWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("imageModel", value);
        applied.model = value;
    }
    if (typeof input.quality === "string" && input.quality.trim()) {
        configStore.updateConfig("quality", input.quality);
        applied.quality = input.quality;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.count != null) {
        const count = String(Math.max(1, Math.min(15, Math.floor(Number(input.count)) || 1)));
        configStore.updateConfig("count", count);
        applied.count = count;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/image");
    const taskId = useWorkbenchAgentStore.getState().dispatchImage({ prompt, run });
    return { ok: true, navigated: "/image", prompt, run, taskId, applied, note: siteText(run ? "imageGenerationStarted" : "imageConfigApplied") };
}

function getVideoConfig() {
    const { config } = useConfigStore.getState();
    const model = config.videoModel || config.model;
    const settings = videoSettingsForModel(config, model);
    return {
        current: {
            model,
            modelName: modelOptionName(model),
            size: settings.ratio,
            seconds: settings.seconds,
            resolution: settings.resolution,
            generateAudio: settings.audioOptions ? settings.generateAudio : undefined,
            watermark: settings.audioOptions ? settings.watermark : undefined,
            mode: settings.mode,
        },
        models: selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        sizeOptions: videoSizeOptions.filter((item) => settings.ratios.some((ratio) => ratio.value === item.value)),
        secondsRange: settings.secondsRange,
        automaticSeconds: settings.autoSeconds,
        maxReferenceImages: settings.profile.maxImages,
        maxReferenceVideos: settings.profile.maxVideos,
        maxReferenceAudios: settings.profile.maxAudios,
        resolutionOptions: settings.wan ? [{ value: settings.resolution, label: `${settings.resolution}p` }] : settings.resolutions,
        referenceVideo: settings.wan?.referenceVideo ?? true,
        fixedResolution: Boolean(settings.wan),
        modeOptions: [
            { value: "frames", label: i18n.t("settingsPanels.video.modes.frames") },
            { value: "reference", label: i18n.t("settingsPanels.video.modes.reference") },
        ],
    };
}

function runVideoWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const model = typeof input.model === "string" && input.model.trim() ? normalizeModelOptionValue(input.model, configStore.config.channels) : configStore.config.videoModel;
    if (!model || !selectableModelsByCapability(configStore.config, "video").includes(model)) throw new Error("请选择已配置的视频模型");
    const settings = videoSettingsForModel(configStore.config, model);
    if (settings.wan) {
        if (typeof input.resolution === "string" && parseVideoResolution(input.resolution) !== settings.resolution) throw new Error("WAN 分辨率由模型决定，请选择对应分辨率的模型");
        if (typeof input.size === "string" && !settings.ratios.some((item) => item.value === inferVideoRatio(input.size))) throw new Error("WAN 仅支持 16:9、9:16、1:1 和自适应比例");
        if (input.generateAudio != null || input.watermark != null) throw new Error("WAN 暂不提供生成音频或水印开关");
    }
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("videoModel", value);
        applied.model = value;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("videoSize", inferVideoRatio(input.size));
        applied.size = inferVideoRatio(input.size);
    }
    if (input.seconds != null && String(input.seconds).trim()) {
        const seconds = String(input.seconds);
        configStore.updateConfig("videoSeconds", seconds);
        applied.seconds = seconds;
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
        configStore.updateConfig("vquality", input.resolution);
        applied.resolution = input.resolution;
    }
    if (typeof input.generateAudio === "boolean") {
        configStore.updateConfig("videoGenerateAudio", String(input.generateAudio));
        applied.generateAudio = input.generateAudio;
    }
    if (typeof input.watermark === "boolean") {
        configStore.updateConfig("videoWatermark", String(input.watermark));
        applied.watermark = input.watermark;
    }
    if (input.mode === "frames" || input.mode === "reference") {
        configStore.updateConfig("videoMode", input.mode);
        applied.mode = input.mode;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/video");
    const taskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt, run });
    return { ok: true, navigated: "/video", prompt, run, taskId, applied, note: siteText(run ? "videoGenerationStarted" : "videoConfigApplied") };
}

async function searchPrompts(input: SiteToolInput) {
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize)) || 20));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const result = await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || i18n.t("common.all")), tag: tags, page, pageSize });
    return {
        total: result.total,
        page,
        pageSize,
        categories: result.categories,
        tags: result.tags.slice(0, 60),
        items: result.items.map((prompt) => ({ id: prompt.id, title: prompt.title, prompt: prompt.prompt, category: prompt.category, tags: prompt.tags, coverUrl: prompt.coverUrl, githubUrl: prompt.githubUrl })),
    };
}

async function listAssets(input: SiteToolInput) {
    await useAssetStore.getState().load();
    const { assets } = useAssetStore.getState();
    const kind = input.kind === "text" || input.kind === "image" || input.kind === "video" ? input.kind : "all";
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = assets.filter((asset) => {
        if (kind !== "all" && asset.kind !== kind) return false;
        if (!keyword) return true;
        return [asset.title, asset.note, asset.source, ...asset.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags,
        source: asset.source,
        note: asset.note,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        coverUrl: asset.coverUrl || undefined,
        content: asset.kind === "text" ? asset.data.content : undefined,
    }));
    return { total: filtered.length, page, pageSize, items };
}

async function addAsset(input: SiteToolInput) {
    const kind = input.kind;
    const title = String(input.title || "").trim();
    if (!title) throw new Error(siteText("assetTitleRequired"));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const source = typeof input.source === "string" ? input.source : "Agent";
    const note = typeof input.note === "string" ? input.note : undefined;
    const store = useAssetStore.getState();
    if (kind === "text") {
        const content = String(input.content || "").trim();
        if (!content) throw new Error(siteText("textContentRequired"));
        const id = await store.addAsset({ kind: "text", title, coverUrl: "", tags, source, note, data: { content } });
        return { ok: true, id, kind: "text" };
    }
    if (kind === "image") {
        const imageUrl = String(input.imageUrl || "").trim();
        if (!imageUrl) throw new Error(siteText("imageUrlRequired"));
        let stored;
        try {
            stored = await uploadImage(imageUrl);
        } catch {
            throw new Error(siteText("imageReadFailed"));
        }
        const id = await store.addAsset({ kind: "image", title, coverUrl: stored.url, tags, source, note, data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
        return { ok: true, id, kind: "image" };
    }
    throw new Error(siteText("assetKindUnsupported"));
}

function paginate(input: SiteToolInput, total: number, defaultSize: number) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || defaultSize));
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(maxPage, Math.max(1, Math.floor(Number(input.page)) || 1));
    const start = (page - 1) * pageSize;
    return { page, pageSize, start, end: start + pageSize };
}
