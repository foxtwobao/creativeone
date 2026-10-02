import axios from "axios";

import i18n from "@/i18n";
import { cloudErrorMessage } from "./error-message";
import { cloudApi, cloudFileUrl } from "./cloud";
import { videoSettingsForModel } from "@/lib/video-settings";
import { resolveMediaUrl, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { buildApiUrl, modelOptionName, modelVideoTypeOf, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { wanModelProfile } from "../../../../shared/video-models";
import { VIDEO_POLL_INTERVAL_MS } from "../../../../shared/video-tasks";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; task_id?: string; status?: string; error?: string | { message?: string }; file?: UploadedFile };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = UploadedFile;
export type VideoGenerationTask = { id: string; provider: "seedance" | "wan"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const wan = task.provider === "wan";
    const timeout = new AbortController();
    const timer = wan ? setTimeout(() => timeout.abort(), 15 * 60_000) : undefined;
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
        for (let attempt = 0; ; attempt += 1) {
            signal.throwIfAborted();
            const state = await pollVideoGenerationTask(config, task, { signal });
            if (state.status === "completed") return state.result;
            if (state.status === "failed") throw videoTaskFailed(state.error);
            if (!wan && attempt === 119) throw new Error(apiText("videoTimeout", { provider: "" }));
            await delay(VIDEO_POLL_INTERVAL_MS, signal);
        }
    } catch (error) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (timeout.signal.aborted) throw new Error("前台已等待 15 分钟，后台任务不受影响，可稍后继续查询");
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    const settings = videoSettingsForModel(config, selectedModel, references.length);
    if (settings.error) throw new Error(settings.error);
    if (modelVideoTypeOf(config, selectedModel) === "wan") return createWanTask(config, requestConfig, selectedModel, prompt, references, options);
    const [images, videos, audios] = await Promise.all([
        Promise.all(references.map((image) => imageToDataUrl(image))),
        Promise.all((options?.videos || []).map(async (video) => video.storageKey ? resolveMediaUrl(video.storageKey, video.url) : video.url)),
        Promise.all((options?.audios || []).map(async (audio) => audio.storageKey ? resolveMediaUrl(audio.storageKey, audio.url) : audio.url)),
    ]);
    const { mode, ratio, resolution, seconds, generateAudio, watermark } = settings;
    const body = {
        model: modelOptionName(selectedModel),
        content: [
            { type: "text", text: prompt },
            ...images.map((url, index) => ({ type: "image_url", image_url: { url }, role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" })),
            ...videos.map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" })),
            ...audios.map((url) => ({ type: "audio_url", audio_url: { url }, role: "reference_audio" })),
        ],
        duration: Number(seconds),
        resolution: `${resolution}p`,
        ratio: ratio === "auto" ? "adaptive" : ratio,
        generate_audio: generateAudio,
        watermark: watermark,
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(requestConfig, "/contents/generations/tasks"), body, { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "seedance", model: selectedModel };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    try {
        const path = task.provider === "wan" ? "/videos" : "/contents/generations/tasks";
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(requestConfig, `${path}/${encodeURIComponent(task.id)}`), { headers: aiHeaders(requestConfig), signal: options?.signal })).data);
        if (video.status === "paused") throw new Error(readApiErrorMessage(video.error) || "后台任务已暂停，可手动恢复处理");
        if (["failed", "cancelled", "expired"].includes(video.status || "")) return { status: "failed", error: readApiErrorMessage(video.error) || apiText("videoGenerationFailed") };
        if (video.status !== (task.provider === "wan" ? "completed" : "succeeded")) return { status: "pending" };
        if (!video.file?.url.startsWith("/api/files/media_files/") || !video.file.storageKey) throw new Error("服务端尚未返回已保存的视频文件，请继续查询任务");
        return { status: "completed", result: video.file };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

export async function resumeVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    const path = task.provider === "wan" ? "/videos" : "/contents/generations/tasks";
    try {
        await axios.post(aiApiUrl(requestConfig, `${path}/${encodeURIComponent(task.id)}/resume`), {}, { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal });
    } catch (error) { throw new Error(readAxiosError(error, "恢复后台任务失败")); }
}

async function referenceUrl(namespace: "image_files" | "media_files", item: { storageKey?: string; url?: string }, options?: RequestOptions) {
    if (item.storageKey) return cloudFileUrl(namespace, item.storageKey);
    if (item.url?.startsWith("/api/files/")) return item.url;
    if (!item.url) throw new Error("参考文件地址无效，请重新选择");
    return (await cloudApi<{ url: string }>("/files/import", { method: "POST", body: JSON.stringify({ url: item.url }), signal: options?.signal })).url;
}

async function createWanTask(config: AiConfig, requestConfig: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const profile = wanModelProfile(modelOptionName(model));
    if (!profile) throw new Error("WAN 模型名需包含有效的分辨率后缀");
    if (!profile.referenceVideo && options?.videos?.length) throw new Error("当前 WAN 图生模型不支持参考视频");
    if (!profile.referenceVideo && !references.length) throw new Error("WAN 图生模型需要至少一张参考图片");
    if (references.length > 10) throw new Error("WAN 最多支持 10 张参考图");
    const { mode, ratio, seconds } = videoSettingsForModel(config, model, references.length);
    const [reference_images, reference_videos, reference_audios] = await Promise.all([
        Promise.all(references.map(async (image, index) => {
            const key = image.storageKey || (await uploadImage(await imageToDataUrl(image, options), options)).storageKey;
            if (!key) throw new Error("参考图片上传失败");
            return { url: cloudFileUrl("image_files", key), role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" };
        })),
        Promise.all((options?.videos || []).map(async (video) => {
            return { url: await referenceUrl("media_files", video, options) };
        })),
        Promise.all((options?.audios || []).map(async (audio) => {
            return { url: await referenceUrl("media_files", audio, options) };
        })),
    ]);
    const body = { model: modelOptionName(model), prompt, seconds, aspect_ratio: ratio === "auto" ? "adaptive" : ratio, reference_images, reference_videos, reference_audios };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(requestConfig, "/videos"), body, { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal })).data);
        const id = created.id || created.task_id;
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "wan", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        return cloudErrorMessage(responseData) || readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
