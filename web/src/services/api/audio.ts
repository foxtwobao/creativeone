import { cloudApi, CloudError } from "./cloud";
import { decodeChannelModel, modelAudioTypeOf, type AiConfig } from "@/stores/use-config-store";
import { audioInputError, type AudioInput } from "../../../../shared/audio";
import type { CanvasGenerationContext } from "./image";
import type { UploadedFile } from "@/services/file-storage";

export type AudioSubmission = { model: string; audio_type: NonNullable<ReturnType<typeof modelAudioTypeOf>>; audio_input: AudioInput; submission_id?: string; title?: string };
export function audioSubmission(config: AiConfig, model: string, input: AudioInput, title = "", textContext = ""): AudioSubmission {
    const type = modelAudioTypeOf(config, model);
    if (!type || !decodeChannelModel(model)) throw new Error("所选音频模型已停用或未配置调用类型，请重新选择。");
    const error = audioInputError(type, input, textContext);
    if (error) throw new Error(error);
    const audio_input = "text" in input ? { mode: input.mode, text: input.text, voice: input.voice, speakers: structuredClone(input.speakers) } : structuredClone(input);
    return { model, audio_type: type, audio_input, title };
}
export async function submitAudio(submission: AudioSubmission, options: { signal?: AbortSignal; canvasContext?: CanvasGenerationContext; checkExisting?: boolean } = {}) {
    if (options.checkExisting && submission.submission_id) {
        try { return await cloudApi<{ canvasTaskId: string }>(`/audio/submissions/${submission.submission_id}`, { signal: options.signal }); }
        catch (error) { if (!(error instanceof CloudError && error.status === 404)) throw error; }
    }
    const model = decodeChannelModel(submission.model);
    if (!model) throw new Error("请选择音频模型");
    return cloudApi<{ canvasTaskId: string }>(`/ai/${model.channelId}/v1/chat/completions`, { method: "POST", signal: options.signal, body: JSON.stringify({ ...submission, model: model.model, ...(options.canvasContext ? { canvas_context: options.canvasContext } : {}) }) });
}
export async function uploadAudio(file: File) {
    const form = new FormData(); form.append("file", file);
    return cloudApi<UploadedFile>("/files/canvas-import", { method: "POST", body: form });
}
