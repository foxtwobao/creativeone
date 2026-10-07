import { parseFile } from "music-metadata";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createFile, type MP4BoxBuffer } from "mp4box";
import { env } from "./config.js";

export function videoMetadata(bytes: Buffer) {
    let metadata: { width?: number; height?: number; durationMs?: number } = {};
    try {
        const file = createFile();
        file.onError = () => {};
        file.onReady = (info) => {
            const track = info.videoTracks[0];
            if (track?.video) metadata = { width: track.video.width, height: track.video.height, durationMs: track.timescale ? Math.round(track.duration / track.timescale * 1000) : undefined };
        };
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as MP4BoxBuffer;
        buffer.fileStart = 0;
        file.appendBuffer(buffer);
        file.flush();
    } catch { /* Metadata is optional; a parsing failure must not discard the saved video. */ }
    return metadata;
}

export async function storedMediaMetadata(diskId: string, mime: string) {
    const path = resolve(env.MEDIA_DIR, diskId);
    const audio = await parseFile(path, { duration: true, skipCovers: true }).catch(() => null);
    let metadata: { width?: number; height?: number; durationMs?: number } = {};
    if (audio?.format.duration && Number.isFinite(audio.format.duration)) metadata.durationMs = Math.round(audio.format.duration * 1000);
    if (mime.startsWith("video/")) metadata = { ...metadata, ...videoMetadata(await readFile(path)) };
    return metadata;
}
