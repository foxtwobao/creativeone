import { imageIntegrationCapabilities, videoIntegrationCapabilities, musicIntegrationCapabilities } from "./integration-capabilities.js";
import { canonicalize } from "json-canonicalize";
import { createHash } from "node:crypto";
import { db } from "./db.js";
import { attachModelProfiles } from "./model-profiles.js";
import { imageConfiguredProfile, type ImageModelConfig, channelImageConfig } from "../../shared/image-models.js";
import { type VideoModelConfig, videoReferenceMode, channelVideoConfig, channelVideoProfile } from "../../shared/video-models.js";
import { canvasRequestBody } from "../../shared/canvas-request.js";
import { videoTaskPath } from "../../shared/video-tasks.js";
import { videoRequestBody } from "../../shared/video-request.js";
import { parseVideoResolution } from "../../shared/media-size.js";
import type { AudioModelType } from "../../shared/audio.js";
import { audioSnapshot } from "./audio.js";
import { imageRequestCapabilityError, videoRequestCapabilityError } from "./model-capabilities.js";

export type IntegrationSelection = { kind: string; model: string; path: string; presetId: string; parameters: Record<string, any>; references?: { images: string[]; videos: string[]; audios: string[] }; image?: ImageModelConfig; video?: VideoModelConfig; audioType?: AudioModelType };
export function integrationRequest(selection: IntegrationSelection, prompt: string, overrides: Record<string, unknown>) {
    const { kind, model, image, video } = selection;
    const references = selection.references || { images: [], videos: [], audios: [] };
    const hasReferences = Object.values(references).some(urls => urls.length);
    if (kind === "music" && hasReferences || image && (references.videos.length || references.audios.length)) throw new Error("当前模型不支持此类参考素材");
    const capabilities = image ? imageIntegrationCapabilities(image) : video ? videoIntegrationCapabilities(video) : musicIntegrationCapabilities();
    const parameters = { ...selection.parameters, ...capabilities.parameterSchema.parse(overrides) };
    let request: any;
    if (kind === "music") return audioSnapshot(model, selection.audioType!, { mode: parameters.mode, description: prompt });
    if (image) {
        const profile = imageConfiguredProfile(image);
        request = canvasRequestBody(model, "image", image.callType, {
            prompt, ...(image.callType === "grok" ? {} : { size: parameters.size || "auto" }),
            quality: parameters.quality || profile.defaults.quality, background: parameters.background ?? "",
        }, references, "", "", undefined, image);
        if (image.callType === "grok") {
            const locked = profile.singleReferenceRatioLocked && references.images.length === 1;
            if (locked && overrides.aspect_ratio !== undefined && overrides.aspect_ratio !== "auto") throw new Error("单参考图沿用原图画幅");
            for (const key of ["aspect_ratio", "resolution", "quality"]) {
                if (!(locked && key === "aspect_ratio") && parameters[key] && parameters[key] !== "auto") request[key] = parameters[key];
                else delete request[key];
            }
        }
    } else {
        const profile = video!.profile!;
        request = videoRequestBody(model, video!, prompt, references, {
            resolution: parseVideoResolution(parameters.resolution), ratio: parameters.ratio === "adaptive" ? "auto" : parameters.ratio,
            seconds: String(parameters.seconds ?? profile.defaults.seconds), mode: parameters.mode ?? videoReferenceMode(profile, references.videos.length || references.audios.length ? "reference" : undefined, references.images.length),
            generateAudio: parameters.generateAudio, watermark: parameters.watermark, fastMode: parameters.fastMode, seed: parameters.seed,
        });
    }
    const error = image ? imageRequestCapabilityError(model, image, request) : videoRequestCapabilityError(model, video!, request);
    if (error) throw new Error(error);
    return hasReferences ? { ...request, user_prompt: prompt } : request;
}

export const integrationPath = (selection: IntegrationSelection) => selection.image && selection.references?.images.length && selection.image.callType !== "banana" ? "images/edits" : selection.path;

export const canonical = canonicalize;
const id = (value: any) => createHash("sha256").update(canonical(value)).digest("hex");
export async function integrationModels(client: Pick<typeof db, "query"> = db) {
    const channels = await attachModelProfiles((await client.query("SELECT * FROM channels WHERE enabled AND capability IN ('image','video','audio') ORDER BY is_default DESC,id")).rows, client);
    const selections: { id: string; name: string; description?: string; parameters: object; constraints: object; inputs: { referenceImages: boolean; referenceVideos: boolean; referenceAudios: boolean }; kind: string; channel: any; model: string; presets: { id: string; parameters: any; selection: IntegrationSelection; path: string }[]; defaultPreset: string }[] = [];
    for (const channel of channels) for (const model of channel.models) {
        if (channel.capability === "audio" && !["suno", "lyria"].includes(channel.audio_types?.[model])) continue;
        const kind = channel.capability === "audio" ? "music" : channel.capability;
        const modelId = id([channel.id, model]);
        const presets: (typeof selections)[number]["presets"] = [];
        for (const mode of kind === "music" ? ["song", "instrumental"] as const : [undefined]) {
            try {
                const image = kind === "image" ? channelImageConfig(channel, model) : undefined;
                const video = kind === "video" ? channelVideoConfig(channel, model) : undefined;
                const build = (prompt: string) => kind === "music" ? audioSnapshot(model, channel.audio_types[model], { mode: mode!, description: prompt }) : canvasRequestBody(model, kind, image?.callType || channelVideoProfile(channel, model).family, { prompt }, { images: [], videos: [], audios: [] }, "", "", video, image);
                const request = (prompt: string) => {
                    const body = build(prompt);
                    const error = kind === "image" ? imageRequestCapabilityError(model, image!, body) : kind === "video" ? videoRequestCapabilityError(model, video!, body) : undefined;
                    if (error) throw new Error(error);
                    return body;
                };
                const sample: any = request("创作");
                const parameters = kind === "music" ? { mode } : Object.fromEntries(Object.entries(kind === "image" ? {
                    size: sample.size, resolution: sample.resolution, aspect_ratio: sample.aspect_ratio, quality: sample.quality, background: sample.background,
                } : {
                    resolution: sample.resolution, ratio: sample.ratio, seconds: sample.duration,
                    generateAudio: sample.generate_audio ?? sample.metadata?.parameters?.audio,
                    watermark: sample.watermark ?? sample.metadata?.parameters?.watermark, fastMode: sample.metadata?.parameters?.fast_mode,
                }).filter(([, value]) => value !== undefined));
                // Include protocol and actual normalized request so changes in effective semantics change the ID.
                const path = kind === "music" ? "chat/completions" : kind === "video" ? videoTaskPath(video!.callType) : "images/generations";
                const presetId = id([modelId, path, sample]);
                presets.push({ id: presetId, parameters, path, selection: { kind, model, path, presetId, parameters, ...(image ? { image } : {}), ...(video ? { video } : {}), ...(kind === "music" ? { audioType: channel.audio_types[model] } : {}) } });
            } catch { /* A model without a valid text-only default is not advertised. */ }
        }
        if (presets.length) {
            const capabilities = kind === "image" ? imageIntegrationCapabilities(channelImageConfig(channel, model)) : kind === "video" ? videoIntegrationCapabilities(channelVideoConfig(channel, model)) : musicIntegrationCapabilities();
            selections.push({ id: modelId, name: model, ...(channel.model_descriptions?.[model] ? { description: channel.model_descriptions[model] } : {}), ...capabilities, inputs: { referenceImages: kind === "image" ? channel.image_profiles[model].maxReferences !== 0 : kind === "video" && channel.video_profiles[model].maxImages !== 0, referenceVideos: kind === "video" && channel.video_profiles[model].maxVideos !== 0, referenceAudios: kind === "video" && channel.video_profiles[model].maxAudios !== 0 }, kind, model, channel, presets, defaultPreset: presets[0].id });
        }
    }
    return selections;
}
