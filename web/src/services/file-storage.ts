import { createUserStore } from "@/services/cloud-storage";
import { cloudApi, cloudFileUrl } from "@/services/api/cloud";
import { nanoid } from "nanoid";


export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = createUserStore("media_files");
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = cloudFileUrl("media_files", storageKey);
    objectUrls.set(storageKey, url);
    return describeMediaFile(url, storageKey, blob);
}

async function describeMediaFile(url: string, storageKey: string, blob: Blob): Promise<UploadedFile> {
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(blob) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    return cloudFileUrl("media_files", storageKey);
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = cloudFileUrl("media_files", storageKey);
    objectUrls.set(storageKey, url);
    return url;
}




function readVideoMeta(blob: Blob) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(blob);
        const done = () => {
            const meta = { width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined };
            video.onloadedmetadata = video.onerror = null;
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
            resolve(meta);
        };
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
        video.load();
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
