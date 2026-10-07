import { fetchGenerationHistory, removeGenerationHistory } from "@/services/api/history";
import { useCloudStore } from "@/stores/use-cloud-store";
import { cloudSession } from "@/services/api/cloud";
import { useQuery } from "@tanstack/react-query";
import { useAuthorizationDraft } from "@/hooks/use-authorization-draft";
import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Plus, SlidersHorizontal, PenLine, Search, Send, X, Trash2, Upload, VideoIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Checkbox, Drawer, Input, InputNumber, Modal, Popover, Select, Switch, Tag, Typography } from "antd";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { normalizeVideoResolutionValue, videoModeLabel, videoSizeLabel } from "@/lib/video-settings";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, isVideoTaskFailed, resumeVideoGenerationTask, waitForVideoGenerationTask, type VideoGenerationTask } from "@/services/api/video";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { videoModeOptions, videoResolutionLabel, videoSecondsLabel, videoSizeOptions, videoSettingsForModel } from "@/lib/video-settings";
import i18n from "@/i18n";
import { needsModelAuthorization, splitErrorMessage } from "@/services/api/error-message";

const AssetPickerModal = lazy(() => import("@/components/canvas/asset-picker-modal").then((module) => ({ default: module.AssetPickerModal })));

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "videoSize" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">;



export default function VideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const agentTaskIdsRef = useRef(new Map<string, string>());
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [referenceVideos, setReferenceVideos] = useState<ReferenceVideo[]>([]);
    const [referenceAudios, setReferenceAudios] = useState<ReferenceAudio[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [running, setRunning] = useState(false);
    const [uploadingMedia, setUploadingMedia] = useState(0);
    const [logPage, setLogPage] = useState(1);
    const [logsOpen, setLogsOpen] = useState(false);
    const [logSearch, setLogSearch] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptGuideOpen, setPromptGuideOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const userId = cloudSession?.user.id;
    const { data: history, refetch: refetchLogs, isFetching: logsLoading } = useQuery({
        queryKey: ["generation-history", userId, "video", logPage, logSearch],
        queryFn: () => readStoredLogs(logPage, logSearch),
        enabled: false,
    });
    const logs = history?.logs || [];
    const logTotal = history?.total || 0;
    useAuthorizationDraft({ prompt, references, referenceVideos, referenceAudios, results }, (draft) => {
        setPrompt(draft.prompt);
        setReferences(draft.references);
        setReferenceVideos(draft.referenceVideos || []);
        setReferenceAudios(draft.referenceAudios || []);
        setResults(draft.results);
    }, running);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const videoSettings = videoSettingsForModel(effectiveConfig, model, references.length, { videos: referenceVideos, audios: referenceAudios });
    const canGenerate = Boolean(prompt.trim()) && !uploadingMedia && !videoSettings.error;

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        const refresh = () => { if (!document.hidden) void refreshLogs(true).catch((error) => message.error(error.message)); };
        refresh();
    }, [refetchLogs, logPage, logSearch]);

    useEffect(() => {
        if (!logsOpen) return;
        const refresh = () => { if (!document.hidden) void refreshLogs(true).catch((error) => message.error(error.message)); };
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [refetchLogs, logPage, logSearch, logsOpen]);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addMediaReferences = async (files: FileList | null, kind: "video" | "audio") => {
        setUploadingMedia((count) => count + 1);
        try {
            const items = await Promise.all(Array.from(files || []).filter((file) => file.type.startsWith(`${kind}/`)).map(async (file) => {
                const stored = await uploadMediaFile(file, `reference-${kind}`);
                return { id: nanoid(), name: file.name, type: file.type, url: stored.url, storageKey: stored.storageKey, durationMs: stored.durationMs };
            }));
            if (kind === "video") setReferenceVideos((current) => [...current, ...items]);
            else setReferenceAudios((current) => [...current, ...items]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "参考素材上传失败");
        } finally {
            setUploadingMedia((count) => count - 1);
        }
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("videoWorkbench.clipboardEmpty"));
        }
    };
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, { videos: snapshot.referenceVideos, audios: snapshot.referenceAudios });
            const log = (await readStoredLogs(1, "", task.id)).logs[0];
            if (!log) throw new Error("任务已提交，请到生成任务查看状态");
            await refreshLogs();
            void pollGenerationLog(log, { config: snapshot.config, agentTaskId });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await refreshLogs().catch((error) => message.error(error.message));
            if (!needsModelAuthorization(errorMessage)) message.error(errorMessage);
            setRunning(false);
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && running) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        if (uploadingMedia) {
            message.warning("请等待参考素材上传完成");
            return null;
        }
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        if (videoSettings.error) { message.error(videoSettings.error); return null; }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...references], referenceVideos: [...referenceVideos], referenceAudios: [...referenceAudios] };
    };

    const retryResult = () => {
        const pending = logs.find((log) => log.id === results[0]?.id && log.status === "pending" && log.task);
        if (pending) {
            setResults([{ id: pending.id, status: "pending" }]);
            void pollGenerationLog(pending, { resume: true });
        }
        else void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = async (video: GeneratedVideo) => {
        try {
        await addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
        } catch (error) { message.error(error instanceof Error ? error.message : "素材保存失败"); }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setReferenceVideos([]);
        setReferenceAudios([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = async () => {
        try { await Promise.all(selectedLogIds.map(removeGenerationHistory)); await refreshLogs(); }
        catch (error) { message.error(error instanceof Error ? error.message : "历史记录移除失败"); return; }
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const refreshGenerationLog = async (log: GenerationLog, resumePending = false) => {
        const logs = await refreshLogs(resumePending);
        return logs.find((item) => item.id === log.id) || (log.task ? (await readStoredLogs(1, "", log.task.id)).logs[0] : undefined);
    };

    const refreshLogs = async (resumePending = false) => {
        const { data } = await refetchLogs({ cancelRefetch: false, throwOnError: true });
        const nextLogs = data?.logs || [];
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "pending" && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, options: { config?: AiConfig; agentTaskId?: string; resume?: boolean } = {}) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        const agentTaskId = options.agentTaskId || agentTaskIdsRef.current.get(log.id);
        activeLogIdsRef.current.add(log.id);
        if (agentTaskId) {
            agentTaskIdsRef.current.set(log.id, agentTaskId);
            updateAgentTask(agentTaskId, { status: "running", error: undefined });
        }
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        const taskConfig = options.config || buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            if (options.resume) await resumeVideoGenerationTask(taskConfig, log.task);
            const stored = await waitForVideoGenerationTask(taskConfig, log.task);
            const nextVideo: GeneratedVideo = {
                id: log.id,
                url: stored.url,
                storageKey: stored.storageKey,
                durationMs: Date.now() - log.createdAt,
                width: stored.width || 1280,
                height: stored.height || 720,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            };
            setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "succeeded", successCount: 1, failCount: 0, error: undefined });
            const saved = await refreshGenerationLog(log);
            if (saved?.video) setResults([{ id: saved.video.id, status: "success", video: saved.video }]);
            else if (!saved) setResults([]);
            message.success(t("videoWorkbench.generated"));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            const failed = isVideoTaskFailed(error);
            const resumableMessage = `${errorMessage.replace(/[。.!！\s]+$/, "")}。任务已保留，可稍后手动恢复查询。`;
            setResults([{ id: log.id, status: "failed", error: failed ? errorMessage : resumableMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: failed ? "failed" : "unknown", successCount: 0, failCount: failed ? 1 : 0, error: failed ? errorMessage : resumableMessage });
            if (failed) await refreshGenerationLog(log);
            if (failed && !needsModelAuthorization(errorMessage)) message.error(errorMessage);
        } finally {
            activeLogIdsRef.current.delete(log.id);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        setReferenceVideos(log.referenceVideos || []);
        setReferenceAudios(log.referenceAudios || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.videoSize) updateConfig("videoSize", log.config.videoSize);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        if (log.config.videoMode) updateConfig("videoMode", log.config.videoMode);
        setResults(log.status === "pending" ? [{ id: log.id, status: activeLogIdsRef.current.has(log.id) ? "pending" : "failed", error: "任务已保留，可继续查询" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || t("workbench.generationFailed") }]);
    };

    return (
        <div className="studio-workbench">
            <main className={`studio-stage ${results.length ? "has-results" : ""}`}>
                <div className="studio-page-tools"><span>视频创作工作台</span><button className="studio-chip" disabled={running} onClick={createSession}><PenLine size={14} />新建创作</button></div>
                <section className="studio-compose-area">
                    <h1><span>让灵感流动，</span>故事由此开始</h1>
                    <div className="studio-compose-tools">
                        <button className="studio-chip" onClick={() => { setLogsOpen(true); void refreshLogs(true).catch((error) => message.error(error.message)); }}><History size={14} />历史记录</button>
                        <button className="studio-chip" onClick={() => setPromptGuideOpen(true)}><BookOpen size={14} />写作参考</button>
                        <button className="studio-chip" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={14} />视频设置</button>
                    </div>
                    <div className="studio-composer" style={referenceDragTarget ? { outline: "2px solid var(--studio-accent)" } : undefined} onDragEnter={handleReferenceDragEnter} onDragLeave={handleReferenceDragLeave} onDragOver={(event) => event.preventDefault()} onDrop={handleReferenceDrop}>
                        {references.length ? <div className="studio-references">{references.map((item, index) => (
                            <div key={item.id}>
                                <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} />
                                <span>{videoSettings.mode === "reference" ? `参考图 ${index + 1}` : index === 0 ? "首帧" : "尾帧"}</span>
                                <button aria-label="移除参考图" onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}><X size={12} /></button>
                                <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                            </div>
                        ))}</div> : null}
                        {referenceVideos.length || referenceAudios.length ? <div className="flex flex-wrap gap-2 px-3 text-xs text-muted-foreground">
                            {referenceVideos.map((item) => <span key={item.id}>视频：{item.name}<button aria-label={`移除 ${item.name}`} onClick={() => setReferenceVideos((value) => value.filter((ref) => ref.id !== item.id))}><X className="ml-1 inline size-3" /></button></span>)}
                            {referenceAudios.map((item) => <span key={item.id}>音频：{item.name}<button aria-label={`移除 ${item.name}`} onClick={() => setReferenceAudios((value) => value.filter((ref) => ref.id !== item.id))}><X className="ml-1 inline size-3" /></button></span>)}
                        </div> : null}
                        <div className="studio-input-row">
                            <Popover trigger="click" placement="bottomLeft" content={<div className="flex flex-col gap-1"><Button type="text" icon={<Upload size={15} />} onClick={() => fileInputRef.current?.click()}>上传参考图</Button><Button type="text" onClick={() => videoInputRef.current?.click()} disabled={videoSettings.profile.maxVideos === 0}>上传参考视频</Button><Button type="text" onClick={() => audioInputRef.current?.click()}>上传参考音频</Button><Button type="text" icon={<FolderPlus size={15} />} onClick={() => setAssetPickerOpen(true)}>从素材选择</Button><Button type="text" icon={<ClipboardPaste size={15} />} onClick={() => void addReferencesFromClipboard()}>从剪贴板粘贴</Button></div>}><button className="studio-icon" aria-label="添加参考素材"><Plus size={23} strokeWidth={1.5} /></button></Popover>
                            <Input.TextArea aria-label="视频创作提示词" variant="borderless" autoSize={{ minRows: 1, maxRows: 8 }} value={prompt} placeholder="描述画面、动作与运镜，让故事动起来…" onChange={(event) => setPrompt(event.target.value)} />
                            <button className="studio-send" aria-label="开始生成视频" disabled={!canGenerate || running} onClick={() => void generate()}>{running ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}</button>
                        </div>
                        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-2">
                            <ModelPicker config={effectiveConfig} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" className="max-w-[min(70vw,320px)]" onMissingConfig={() => openConfigDialog(false)} />
                            <Popover trigger="click" placement="bottomRight" content={<GenerationSettings referenceImageCount={references.length} media={{ videos: referenceVideos, audios: referenceAudios }} showModel={false} />}><button className="studio-chip" onClick={() => window.dispatchEvent(new CustomEvent("model-picker-open", { detail: "parameters" }))}><SlidersHorizontal size={14} />参数</button></Popover>
                        </div>
                    </div>
                    <div className="studio-composer-caption"><span>{modelOptionLabel(effectiveConfig, model)} · {videoResolutionLabel(videoSettings.resolution)} · {videoSizeLabel(videoSettings.ratio)} · {videoSecondsLabel(videoSettings.seconds)} · {videoModeLabel(videoSettings.mode)}</span><span>{uploadingMedia ? "参考素材上传中…" : "点击生成 · Enter 换行"}</span></div>
                    {videoSettings.error ? <p role="alert" className="text-xs text-muted-foreground">{videoSettings.error}</p> : null}
                </section>
                {results.length ? <section className="studio-results">
                    <header><h2>{previewLog ? "历史作品" : "生成结果"}</h2><span>{running ? `正在生成 · ${formatDuration(elapsedMs)}` : "每一帧，都是灵感"}</span></header>
                    <div className="grid gap-4">{results.map((result) => result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} resumable={Boolean(logs.find((log) => log.id === result.id && log.status === "pending" && log.task))} onRetry={retryResult} /> : <PendingVideoCard key={result.id} />)}</div>
                </section> : <section className="studio-inspiration"><div className="studio-inspiration-empty py-8"><VideoIcon size={28} strokeWidth={1.25} /><p>用文字开始，或添加参考图，让静止的画面成为故事。</p><button className="studio-chip" onClick={() => fileInputRef.current?.click()}><Plus size={14} />添加参考图</button></div></section>}
                <p className="studio-local-note">画布ONE · 创作数据按账号保存到云端</p>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <input ref={videoInputRef} type="file" accept="video/*" multiple className="hidden" onChange={(event) => { void addMediaReferences(event.target.files, "video"); event.target.value = ""; }} />
            <input ref={audioInputRef} type="file" accept="audio/*" multiple className="hidden" onChange={(event) => { void addMediaReferences(event.target.files, "audio"); event.target.value = ""; }} />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                {logsLoading ? <p role="status" className="mb-4 text-sm text-muted-foreground">正在加载创作记录…</p> : null}
                <Input className="mb-4" prefix={<Search size={16} />} placeholder="搜索创作记录" aria-label="搜索创作记录" allowClear value={logSearch} onChange={(event) => { setLogSearch(event.target.value); setLogPage(1); }} />
                <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} />
                {logTotal > 10 ? <div className="mt-4 flex items-center justify-center gap-4">
                    <Button disabled={logPage === 1} onClick={() => setLogPage(logPage-1)}>上一页</Button>
                    <span>{logPage} / {Math.ceil(logTotal/10)}</span>
                    <Button disabled={logPage*10 >= logTotal} onClick={() => setLogPage(logPage+1)}>下一页</Button>
                </div> : null}
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="flex justify-center pb-4">
                    <GenerationSettings referenceImageCount={references.length} media={{ videos: referenceVideos, audios: referenceAudios }} />
                </div>
            </Drawer>
            <Modal title="视频提示词写作参考" open={promptGuideOpen} onCancel={() => setPromptGuideOpen(false)} footer={null}>
                <div className="space-y-3 text-sm leading-6">
                    <p>按“主体与场景 → 动作变化 → 镜头运动 → 光线与氛围”描述，让画面在时间中发生变化。</p>
                    <p>例如：清晨的海边，一位穿白色衬衫的人沿沙滩缓慢行走，海风吹动衣角。镜头从侧面跟随，逐渐拉远，露出海岸线，光线柔和自然。</p>
                    <p>使用参考图时，重点说明人物如何移动、镜头如何变化，以及需要保持一致的特征；首尾帧模式还可描述两帧之间的过渡。</p>
                    <p className="text-muted-foreground">现有提示词库主要面向生图，可在图像制作中使用；视频创作建议补充动作、运镜和时间变化。</p>
                </div>
            </Modal>
            {assetPickerOpen ? <Suspense fallback={null}><AssetPickerModal open defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} /></Suspense> : null}
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ showModel = true, referenceImageCount, media }: { showModel?: boolean; referenceImageCount: number; media: { videos: ReferenceVideo[]; audios: ReferenceAudio[] } }) {
    const config = useEffectiveConfig();
    const model = config.videoModel || config.model;
    const settings = videoSettingsForModel(config, model, referenceImageCount, media);
    const { wan, ratio, ratios, resolution, mode, seconds, forcedReference, generateAudio, watermark, error, resolutions, secondsRange, autoSeconds, framesAdaptive } = settings;
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    return <div className="studio-settings">
        <h3>视频生成设置</h3>
        {error ? <p role="alert" className="text-xs text-muted-foreground">{error}</p> : null}
        {showModel ? <div><span>视频模型</span><ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} /></div> : null}
        <div><span>分辨率</span>{wan ? <span>{wan.resolution}p（由模型决定）</span> : <Select aria-label="视频分辨率" value={resolution} options={resolutions} onChange={(value) => updateConfig("vquality", value)} />}</div>
        <div><span>宽高比</span><Select aria-label="视频宽高比" value={ratio} options={videoSizeOptions.filter((item) => ratios.some((option) => option.value === item.value))} onChange={(value) => updateConfig("videoSize", value)} /></div>
        <div><span>时长（秒）</span><InputNumber aria-label="视频时长" className="w-full" min={secondsRange.min} max={secondsRange.max} disabled={seconds === "-1"} precision={0} value={seconds === "-1" ? null : Number(seconds)} onChange={(value) => { if (value !== null) updateConfig("videoSeconds", String(value)); }} /></div>
        {autoSeconds ? <div><span>自动时长</span><Switch aria-label="自动时长" checked={seconds === "-1"} onChange={(value) => updateConfig("videoSeconds", value ? "-1" : "6")} /></div> : null}
        {framesAdaptive ? <p className="text-xs text-muted-foreground">首尾帧生成沿用首帧比例，请选择自动宽高比。</p> : null}
        <div><span>参考模式</span><Select aria-label="视频参考模式" value={mode} options={videoModeOptions.map((item) => ({ ...item, disabled: forcedReference && item.value === "frames" }))} onChange={(value) => updateConfig("videoMode", value)} /></div>
        {!wan ? <><div><span>生成音频</span><Switch aria-label="生成音频" checked={generateAudio} onChange={(value) => updateConfig("videoGenerateAudio", String(value))} /></div>
        <div><span>视频水印</span><Switch aria-label="视频水印" checked={watermark} onChange={(value) => updateConfig("videoWatermark", String(value))} /></div></> : <p className="text-xs text-muted-foreground">参考视频时长参与计费；图生专用模型不支持参考视频。</p>}
        {forcedReference ? <p className="pt-2 text-xs text-muted-foreground">超过两张图片，已使用参考图模式。</p> : null}
    </div>;
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={video.url} controls preload="none" className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, resumable, onRetry }: { error: string; resumable?: boolean; onRetry: () => void }) {
    const { t } = useTranslation();
    const authorized = useCloudStore((state) => state.modelAuthorized);
    const { message: errorMessage, details } = splitErrorMessage(error);
    if (needsModelAuthorization(error)) return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-background p-6 text-center">
            <div className="text-sm font-medium text-foreground">{authorized ? "模型服务授权已完成" : "需要授权模型服务"}</div>
            <p className="text-sm text-muted-foreground">{authorized ? resumable ? "任务已创建，点击继续查询不会重新提交生成。" : "提示词和参考素材已保留。确认创作内容后，点击继续生成；模型调用费用将从 TokenONE 账户余额中扣除。" : "授权后，画布ONE将通过你的 TokenONE 账号调用模型，相关费用从 TokenONE 账户余额中扣除。授权前可查看模型价格。"}</p>
            <Button onClick={authorized ? onRetry : () => useCloudStore.getState().setModelLoginRequired(true)}>{authorized ? resumable ? "继续查询" : "继续生成" : "授权模型服务"}</Button>
        </div>
    );
    return (
        <div className={resumable ? "overflow-hidden rounded-lg border border-border bg-background" : "overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20"}>
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className={resumable ? "text-sm font-medium text-foreground" : "text-sm font-medium text-red-600 dark:text-red-300"}>{resumable ? "任务暂未完成" : t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className={resumable ? "!mb-0 !text-xs !text-muted-foreground" : "!mb-0 !text-xs !text-red-500 dark:!text-red-300"}>
                    {errorMessage}
                </Typography.Paragraph>
                {details ? <details className="max-w-full text-left text-xs text-muted-foreground"><summary className="cursor-pointer text-center">错误详情</summary><pre className="mt-2 whitespace-pre-wrap break-all font-sans">{details}</pre></details> : null}
            </div>
            <div className={resumable ? "flex justify-end border-t border-border p-3" : "flex justify-end border-t border-red-200 p-3 dark:border-red-950"}>
                <Button size="small" danger={!resumable} onClick={onRetry}>
                    {resumable ? "继续查询" : t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard key={log.id} log={log} selected={selectedLogIds.includes(log.id)} active={activeLogId === log.id} onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))} onClick={() => onPreviewLog(log)} />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`} onClick={onClick}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.resolution}p</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "success" ? "blue" : log.status === "pending" ? "processing" : "red"}>
                        {t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(log.durationMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs(page = 1, keyword = "", upstreamId?: string) {
    const result = await fetchGenerationHistory<GenerationLog>("video", page, keyword, upstreamId);
    return { ...result, logs: await Promise.all(result.logs.map(normalizeLog)) };
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        referenceVideos: await Promise.all((log.referenceVideos || []).map(async (item) => ({ ...item, url: await resolveMediaUrl(item.storageKey, item.url) }))),
        referenceAudios: await Promise.all((log.referenceAudios || []).map(async (item) => ({ ...item, url: await resolveMediaUrl(item.storageKey, item.url) }))),
        durationMs: log.durationMs || 0,
        size: log.size || config.videoSize || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "success",
        task: log.task,
        video,
        error: log.error,
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        videoSize: log.config?.videoSize || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        videoMode: log.config?.videoMode === "reference" ? "reference" : "frames",
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    const settings = videoSettingsForModel(config, model);
    return {
        ...config,
        model,
        videoModel: model,
        videoSize: settings.ratio,
        videoSeconds: settings.seconds,
        vquality: settings.resolution,
        videoGenerateAudio: String(settings.generateAudio),
        videoWatermark: String(settings.watermark),
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}
