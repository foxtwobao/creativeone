import type { CanvasNodeData, CanvasNodeMetadata, CanvasNodeImage } from "../web/src/types/canvas";

const resultFields = ["generationId", "generationTaskId", "content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs", "status", "errorDetails", "videoTaskId", "videoTaskProvider", "videoTaskModel"] as const;
function resultMetadata<T extends CanvasNodeMetadata | CanvasNodeImage>(incoming: T, saved: T): T {
    // A new operation may replace a result; ordinary edits and old undo snapshots may not.
    if (!saved.generationTaskId || (incoming.generationId !== saved.generationId && incoming.status === "loading")) return incoming;
    if (resultFields.every((key) => incoming[key as keyof T] === saved[key as keyof T])) return incoming;
    const next = { ...incoming };
    for (const key of resultFields) {
        delete (next as CanvasNodeMetadata)[key];
        if (key in saved) Object.assign(next, { [key]: saved[key as keyof T] });
    }
    return next;
}

export function isCanvasMediaReplacement(node: CanvasNodeData, previous?: CanvasNodeData) {
    const metadata = node.metadata, old = previous?.metadata;
    return Boolean(metadata?.storageKey && metadata.storageKey !== old?.storageKey && !metadata.generationId && !metadata.images?.some((image) => image.generationId) && (old?.generationTaskId || old?.images?.some((image) => image.generationTaskId)));
}

export function preserveCanvasGeneration(incoming: CanvasNodeData, saved?: CanvasNodeData): CanvasNodeData {
    if (!saved?.metadata) return incoming;
    if (incoming.metadata?.generationTaskId && !saved.metadata.generationTaskId && !saved.metadata.generationId && incoming.metadata.storageKey === saved.metadata.storageKey) {
        return { ...incoming, metadata: { ...incoming.metadata, generationId: undefined, generationTaskId: undefined, images: saved.metadata.images, primaryImageId: saved.metadata.primaryImageId } };
    }
    if (!incoming.metadata) return saved.metadata.generationTaskId ? { ...incoming, metadata: resultMetadata({}, saved.metadata) } : incoming;
    let metadata = resultMetadata(incoming.metadata, saved.metadata);
    if (incoming.metadata.images) {
        const oldImages = new Map(saved.metadata.images?.map((image) => [image.id, image]));
        const images = incoming.metadata.images.map((image) => oldImages.has(image.id) ? resultMetadata(image, oldImages.get(image.id)!) : image);
        if (!metadata.primaryImageId && images.some((image) => image.id === saved.metadata!.primaryImageId)) metadata = { ...metadata, primaryImageId: saved.metadata.primaryImageId };
        const primary = images.find((image) => image.id === metadata.primaryImageId && image.status === "success" && image.content) || images.find((image) => image.status === "success" && image.content);
        metadata = { ...metadata, images, ...(primary ? { content: primary.content, storageKey: primary.storageKey, naturalWidth: primary.naturalWidth, naturalHeight: primary.naturalHeight, bytes: primary.bytes, mimeType: primary.mimeType, primaryImageId: primary.id } : {}) };
        if (images.some((image) => image.generationId)) metadata.status = images.some((image) => image.status === "loading") ? "loading" : primary ? "success" : "error";
    }
    return JSON.stringify(metadata) === JSON.stringify(incoming.metadata) ? incoming : { ...incoming, metadata };
}

export function canvasEditableNode(node: CanvasNodeData | undefined) {
    if (!node) return null;
    const clean = structuredClone(node) as CanvasNodeData & { entityId?: string; clientId?: string };
    delete clean.entityId; delete clean.clientId;
    const strip = (metadata: Record<string, unknown>, generated: boolean) => {
        delete metadata.entityId; delete metadata.clientId;
        delete metadata.generationTaskId; delete metadata.status; delete metadata.errorDetails;
        if (generated) for (const key of resultFields) if (key !== "generationId") delete metadata[key];
    };
    if (clean.metadata) {
        const generated = Boolean(clean.metadata.generationId || clean.metadata.images?.some((image) => image.generationId));
        if (clean.metadata.images) for (const image of clean.metadata.images) strip(image as unknown as Record<string, unknown>, Boolean(image.generationId));
        if (generated) clean.metadata.primaryImageId ||= clean.metadata.images?.[0]?.id;
        strip(clean.metadata as unknown as Record<string, unknown>, generated);
    }
    return JSON.parse(JSON.stringify(clean));
}
