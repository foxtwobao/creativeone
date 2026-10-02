import { registerCloudRetry } from "@/services/cloud-storage";
import { create } from "zustand";
import { cloudSession } from "@/services/api/cloud";
import { getAccountResource, changeAccountResource } from "@/services/api/account";
import { useCloudStore } from "@/stores/use-cloud-store";
import type { ImageModelType } from "../../../shared/image-models";
import type { VideoModelType } from "../../../shared/video-models";


export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    imageType?: ImageModelType;
    videoType?: VideoModelType;
    description?: string;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    videoSize: string;
    background: string;
    count: string;
    canvasImageCount: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
export const defaultConfig: AiConfig = {
    baseUrl: "",
    apiKey: "",
    apiFormat: "openai",
    channels: [],
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: [],
    quality: "auto",
    size: "1:1",
    videoSize: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
};

const managedKeys = new Set(["channels", "baseUrl", "apiKey", "apiFormat", "models"]);
function applyCloudConfig(config: AiConfig): AiConfig {
    const channels: ModelChannel[] = (cloudSession?.channels || []).map((channel) => ({
        id: channel.id, name: channel.name, baseUrl: `${window.location.origin}/api/ai/${channel.id}/v1`,
        apiKey: cloudSession?.csrf || "", apiFormat: "openai", models: channel.models.map((name) => ({ name, capability: channel.capability, imageType: channel.image_types[name], videoType: channel.video_types?.[name], description: channel.model_descriptions?.[name] })),
    }));
    const next = { ...config, channels, models: modelOptionsFromChannels(channels), baseUrl: "", apiKey: "", apiFormat: "openai" as const };
    for (const [key, capability] of [["imageModel", "image"], ["textModel", "text"], ["videoModel", "video"], ["audioModel", "audio"]] as const) {
        const choices = selectableModelsByCapability(next, capability);
        next[key] = choices.includes(next[key]) ? next[key] : choices[0] || "";
    }
    next.model = next.imageModel;
    return next;
}


type ConfigStore = {
    config: AiConfig;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};


export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelImageTypeOf(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.imageType;
}

export function modelVideoTypeOf(config: AiConfig, value: string): VideoModelType {
    return findChannelModel(config, value)?.model.videoType || "seedance";
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    if (currentModel && modelMatchesCapability(config, currentModel, capability)) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability)) return defaultModel;
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

let settingsVersion = 0;
let settingsSaving: Promise<void> = Promise.resolve();
const pendingSettings = new Map<string, string>();
function saveSetting(key: string, value: string) {
    pendingSettings.set(key, value);
    const cloud = useCloudStore.getState(); cloud.begin();
    const action = settingsSaving.catch(() => undefined).then(async () => {
        try {
            await changeAccountResource("/settings", { [key]: value });
            if (pendingSettings.get(key) === value) { pendingSettings.delete(key); cloud.setError(`settings/${key}`); }
        } catch (error) { cloud.setError(`settings/${key}`, error instanceof Error ? error.message : "设置保存失败"); throw error; }
        finally { cloud.end(); }
    });
    settingsSaving = action; return action;
}
registerCloudRetry(async () => { await settingsSaving.catch(() => undefined); for (const [key, value] of [...pendingSettings]) await saveSetting(key, value); });

export const useConfigStore = create<ConfigStore>()((set, get) => ({
    config: applyCloudConfig(defaultConfig),
    isConfigOpen: false,
    shouldPromptContinue: false,
    updateConfig: (key, value) => {
        if (managedKeys.has(key) || get().config[key] === value) return;
        settingsVersion++;
        set((state) => ({ config: { ...state.config, [key]: value } }));
        void saveSetting(key, value as string).catch(() => undefined);
    },
    isAiConfigReady: (config, model) => isAiConfigReady(config, model),
    openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
    setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
    clearPromptContinue: () => set({ shouldPromptContinue: false }),
}));
export async function loadUserSettings() {
    const version = settingsVersion;
    const saved = await getAccountResource<Partial<AiConfig>>("/settings");
    if (version !== settingsVersion) return;
    useConfigStore.setState({ config: applyCloudConfig({ ...defaultConfig, ...saved }) });
}

export function useEffectiveConfig() {
    return useConfigStore((state) => state.config);
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(_config: AiConfig, value: string) {
    return modelOptionName(value);
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || { id: "unavailable", name: "模型不可用", baseUrl: "", apiKey: "", apiFormat: "openai" as const, models: [] };
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        imageType: modelImageTypeOf(config, value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}
