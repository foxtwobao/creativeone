import { defaultAudioInput, type AudioInput } from "../../../shared/audio";
import { modelAudioTypeOf, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";

export function audioInputForConfig(config: AiConfig): AudioInput {
    return config.audioInput || defaultAudioInput(modelAudioTypeOf(config, config.model));
}
export function canvasAudioModelPatch(config: AiConfig, metadata: CanvasNodeMetadata | undefined, model: string) {
    const current = audioInputForConfig(config);
    const drafts = { ...metadata?.audioDrafts, ["text" in current ? "speech" : "music"]: current };
    const type = modelAudioTypeOf(config, model);
    return { model, audioDrafts: drafts, audioInput: (type === "gemini-tts" ? drafts.speech : drafts.music) || defaultAudioInput(type) };
}
