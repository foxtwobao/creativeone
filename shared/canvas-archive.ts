import type { CanvasNodeData, CanvasConnection } from "../web/src/types/canvas.js";

const metadataKeys = new Set("content composerContent prompt fontSize generationMode generationType model reasoningEffort size videoSize quality background count textCount texts primaryTextId seconds vquality generateAudio watermark videoMode audioVoice audioFormat audioSpeed audioInstructions references naturalWidth naturalHeight freeResize images primaryImageId storageKey mimeType bytes durationMs groupId".split(" "));
export function canvasArchiveMediaValid(nodes: CanvasNodeData[]) {
    return nodes.every(({ type, metadata }) => (!metadata?.content || !["image", "video", "audio"].includes(type) || Boolean(metadata.storageKey))
        && (metadata?.images || []).every((image) => !image.content || Boolean(image.storageKey))
        && (metadata?.references || []).every((reference) => /^(image|file|video|audio):[^\s]+$/.test(reference) || /^\/api\/files\/(image_files|media_files)\/[^/?#]+$/.test(reference)));
}
// Archives carry editable content and stable file references, never credentials or execution state.
export function archiveCanvasNode(node: CanvasNodeData): CanvasNodeData {
    const metadata = Object.fromEntries(Object.entries(node.metadata || {}).filter(([key]) => metadataKeys.has(key))) as NonNullable<CanvasNodeData["metadata"]>;
    if (metadata.images) metadata.images = metadata.images.map(({ id, storageKey, naturalWidth, naturalHeight, bytes, mimeType }) => ({ id, content: storageKey ? `/api/files/image_files/${encodeURIComponent(storageKey)}` : "", storageKey, naturalWidth, naturalHeight, bytes, mimeType, status: storageKey ? "success" : "idle" }));
    if (metadata.texts) metadata.texts = metadata.texts.map(({ id, content }) => ({ id, content, status: content ? "success" : "idle" }));
    if (["image", "video", "audio"].includes(node.type) && !metadata.storageKey) delete metadata.content;
    if (["image", "video", "audio"].includes(node.type) && metadata.storageKey) metadata.content = `/api/files/${node.type === "image" ? "image_files" : "media_files"}/${encodeURIComponent(metadata.storageKey)}`;
    metadata.status = metadata.content ? "success" : "idle";
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata };
}
export function remapCanvasGraph(nodes: CanvasNodeData[], connections: CanvasConnection[], allocate: () => string) {
    const ids = new Map(nodes.map((node) => [node.id, allocate()]));
    const result = nodes.map((node) => {
        const clean = archiveCanvasNode(node), slots = new Map(clean.metadata?.images?.map((image) => [image.id, allocate()]) || []);
        const texts = new Map(clean.metadata?.texts?.map((text) => [text.id, allocate()]) || []);
        const replace = (value?: string) => value?.replace(/@\[node:([^\]]+)\]/g, (match, id) => ids.has(id) ? `@[node:${ids.get(id)}]` : match);
        return { ...clean, id: ids.get(node.id)!, metadata: { ...clean.metadata, groupId: clean.metadata?.groupId ? ids.get(clean.metadata.groupId) : undefined,
            prompt: replace(clean.metadata?.prompt), composerContent: replace(clean.metadata?.composerContent),
            images: clean.metadata?.images?.map((image) => ({ ...image, id: slots.get(image.id)! })), primaryImageId: slots.get(clean.metadata?.primaryImageId || ""),
            texts: clean.metadata?.texts?.map((text) => ({ ...text, id: texts.get(text.id)! })), primaryTextId: texts.get(clean.metadata?.primaryTextId || "") } };
    });
    return { nodes: result, connections: connections.map((edge) => ({ id: allocate(), fromNodeId: ids.get(edge.fromNodeId)!, toNodeId: ids.get(edge.toNodeId)! })) };
}
