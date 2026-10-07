import { randomUUID } from "node:crypto";
import { videoMetadata } from "./media-metadata.js";
export { videoMetadata } from "./media-metadata.js";
import { db } from "./db.js";
import { env } from "./config.js";
import { HttpError } from "./http.js";
import { isAllowedMediaUrl } from "./media-hosts.js";
import { saveFile } from "./storage.js";

const allowedMediaHosts = new Set([...(env.TOKENONE_BASE_URL ? [new URL(env.TOKENONE_BASE_URL).host] : []), ...env.MEDIA_DOWNLOAD_HOSTS.split(",").map((item) => item.trim()).filter(Boolean)]);

export async function readBytes(response: Response) {
    if (!response.body) throw new HttpError(502, "EMPTY_UPSTREAM_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > env.MAX_MEDIA_BYTES) throw new HttpError(413, "FILE_TOO_LARGE");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function downloadRemoteMedia(url: string, signal: AbortSignal, expectedMime?: string) {
    const parsed = new URL(url);
    if (!isAllowedMediaUrl(parsed, allowedMediaHosts)) {
        console.warn(JSON.stringify({ code: "MEDIA_HOST_NOT_ALLOWED", host: parsed.host, protocol: parsed.protocol }));
        throw new HttpError(502, "MEDIA_HOST_NOT_ALLOWED");
    }
    const response = await fetch(parsed, { redirect: "error", signal });
    if (!response.ok) throw new HttpError(502, "MEDIA_DOWNLOAD_FAILED");
    const receivedMime = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const mimeType = receivedMime === "application/octet-stream" ? expectedMime || receivedMime : receivedMime;
    return { bytes: await readBytes(response), mimeType };
}

export async function saveDownloadedMedia(userId: string, { bytes, mimeType }: Awaited<ReturnType<typeof downloadRemoteMedia>>, client: Pick<typeof db, "query"> = db) {
    const namespace = mimeType.startsWith("image/") ? "image_files" : "media_files";
    const storageKey = `${mimeType.startsWith("image/") ? "image" : "file"}:${randomUUID()}`;
    const storedUrl = await saveFile(userId, namespace, storageKey, bytes, mimeType, client);
    return { url: storedUrl, storageKey, bytes: bytes.length, mimeType, ...(mimeType.startsWith("video/") ? videoMetadata(bytes) : {}) };
}

export async function persistRemoteMedia(userId: string, url: string, signal: AbortSignal, expectedMime?: string) {
    return saveDownloadedMedia(userId, await downloadRemoteMedia(url, signal, expectedMime));
}
