import { z } from "zod";
import { load } from "cheerio";
import { marked } from "marked";
import { parseBuffer } from "music-metadata";
import { fileTypeFromBuffer } from "file-type";
import { Agent } from "undici";
import { audioModelTypes, audioRequestSnapshot, type AudioModelType, type AudioInput } from "../../shared/audio.js";
import { upstreamErrorDetails } from "./model-errors.js";
import { HttpError } from "./http.js";

export const AUDIO_REQUEST_TIMEOUT_MS = 15 * 60_000;
export const audioDispatcher = new Agent({ headersTimeout: AUDIO_REQUEST_TIMEOUT_MS, bodyTimeout: AUDIO_REQUEST_TIMEOUT_MS });

const speaker = z.object({ name: z.string(), voice: z.string() }).strict();
export const audioInputSchema = z.union([
    z.object({ mode: z.enum(["single", "duo"]), text: z.string(), voice: z.string(), speakers: z.array(speaker).length(2) }).strict(),
    z.object({ mode: z.enum(["song", "instrumental"]), description: z.string(), lyrics: z.string() }).strict(),
]);
export const audioSubmissionSchema = z.object({ model: z.string(), audio_type: z.enum(audioModelTypes), audio_input: audioInputSchema, submission_id: z.uuid().optional(), title: z.string().trim().optional() }).strict();
export function audioSnapshot(model: string, type: AudioModelType, input: AudioInput) {
    audioInputSchema.parse(input);
    try { return audioRequestSnapshot(model, type, input); }
    catch { throw new HttpError(400, "INVALID_AUDIO_INPUT"); }
}
export function audioSources(payload: any, type: AudioModelType): string[] {
    if (payload?.error) throw new HttpError(422, "TOKENONE_GENERATION_FAILED");
    if (!Array.isArray(payload?.choices) || !payload.choices.length) throw new HttpError(502, "INVALID_AUDIO_RESPONSE");
    for (const choice of payload.choices) {
        if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") throw new HttpError(502, "INCOMPLETE_AUDIO_RESPONSE");
        if (/^\s*(?:错误\s*[:：]|error\s*[:：])/i.test(choice.message.content)) throw Object.assign(new HttpError(422, "TOKENONE_GENERATION_FAILED"), { upstreamError: upstreamErrorDetails(choice.message.content) });
    }
    const urls: string[] = [];
    if (type === "suno" && payload.data !== undefined) {
        if (!Array.isArray(payload.data) || !payload.data.length) throw new HttpError(502, "INVALID_AUDIO_RESPONSE");
        for (const item of payload.data) urls.push(item?.url);
    } else for (const choice of payload.choices) {
        if (type === "suno") marked.walkTokens(marked.lexer(choice.message.content), (token) => { if (token.type === "link") urls.push(token.href); });
        else {
            const html = load(choice.message.content);
            html("audio[src], audio source[src]").each((_, element) => {
                const url = (html(element).attr("src") || "").trim();
                if (!/^data:audio\//i.test(url)) urls.push(url);
            });
        }
    }
    if (!urls.length) throw new HttpError(502, "INVALID_AUDIO_RESPONSE");
    for (const url of urls) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new HttpError(502, "INVALID_AUDIO_RESPONSE"); }
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new HttpError(502, "INVALID_AUDIO_RESPONSE");
    }
    return [...new Set(urls)];
}
export async function audioFileType(bytes: Buffer) {
    const metadata = await parseBuffer(bytes, undefined, { duration: true, skipCovers: true }).catch(() => null);
    if ((!metadata?.format.codec && !metadata?.format.hasAudio) || !metadata?.format.numberOfChannels || metadata.format.duration === 0) throw new HttpError(502, "INVALID_AUDIO_FILE");
    const container = metadata.format.container?.toUpperCase() || "";
    const mp4 = ["audio/mp4", "video/mp4"].includes((await fileTypeFromBuffer(bytes))?.mime || "");
    const other: Record<string, { format: string; mimeType: string }> = { FLAC: { format: "flac", mimeType: "audio/flac" }, OGG: { format: "ogg", mimeType: "audio/ogg" }, AIFF: { format: "aiff", mimeType: "audio/aiff" }, AIFC: { format: "aiff", mimeType: "audio/aiff" } };
    const type = container === "WAVE" ? { format: "wav", mimeType: "audio/wav" } : container === "MPEG" ? { format: "mp3", mimeType: "audio/mpeg" } : container.includes("M4A") || container.includes("MP4") || mp4 ? { format: "m4a", mimeType: "audio/mp4" } : container.startsWith("ADTS/") ? { format: "aac", mimeType: "audio/aac" } : other[container];
    if (!type) throw new HttpError(502, "INVALID_AUDIO_FILE");
    return { ...type, ...(metadata.format.duration && Number.isFinite(metadata.format.duration) ? { durationMs: Math.round(metadata.format.duration * 1000) } : {}) };
}
