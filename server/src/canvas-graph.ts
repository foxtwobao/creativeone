import { randomUUID } from "node:crypto";
import type { CanvasNodeData, CanvasConnection } from "../../web/src/types/canvas.js";

type Entity = { id: string; clientId?: string; entityId?: string };
const promptIds = (value: string | undefined, ids: Map<string, string>) => value?.replace(/@\[node:([^\]]+)\]/g, (token, id) => ids.has(id) ? `@[node:${ids.get(id)}]` : token);
// UI correlation IDs remain stable while every persisted entity gets a server UUID.
export function canvasGraphView(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const ids = new Map((nodes as Array<CanvasNodeData & Entity>).map((node) => [node.id, node.clientId || node.id]));
    const view = (entity: Entity) => ({ ...entity, id: entity.clientId || entity.id, entityId: entity.id, clientId: undefined });
    return {
        nodes: nodes.map((node) => {
            const slots = new Map((node.metadata?.images as Entity[] || []).map((image) => [image.id, image.clientId || image.id]));
            const texts = new Map((node.metadata?.texts as Entity[] || []).map((text) => [text.id, text.clientId || text.id]));
            return { ...node, ...view(node), ...(node.metadata ? { metadata: { ...node.metadata, groupId: node.metadata.groupId ? ids.get(node.metadata.groupId) : undefined,
                prompt: promptIds(node.metadata.prompt, ids), composerContent: promptIds(node.metadata.composerContent, ids),
                images: node.metadata.images?.map((image) => ({ ...image, ...view(image) })), primaryImageId: slots.get(node.metadata.primaryImageId || ""),
                texts: node.metadata.texts?.map((text) => ({ ...text, ...view(text) })), primaryTextId: texts.get(node.metadata.primaryTextId || "") } } : {}) };
        }),
        connections: connections.map((edge) => ({ ...edge, ...view(edge), fromNodeId: ids.get(edge.fromNodeId)!, toNodeId: ids.get(edge.toNodeId)! })),
    };
}
export function persistCanvasGraph(nodes: CanvasNodeData[], connections: CanvasConnection[], previous: { nodes: CanvasNodeData[]; connections: CanvasConnection[] }) {
    const old = new Map((previous.nodes as Array<CanvasNodeData & Entity>).map((node) => [node.id, node]));
    const ids = new Map(nodes.map((node) => [node.id, old.get(node.id)?.entityId || randomUUID()]));
    return {
        nodes: nodes.map((node) => {
            const previousNode = old.get(node.id);
            const oldSlots = new Map((previousNode?.metadata?.images as Entity[] || []).map((image) => [image.id, image.entityId]));
            const oldTexts = new Map((previousNode?.metadata?.texts as Entity[] || []).map((text) => [text.id, text.entityId]));
            const slots = new Map((node.metadata?.images || []).map((image) => [image.id, oldSlots.get(image.id) || randomUUID()]));
            const texts = new Map((node.metadata?.texts || []).map((text) => [text.id, oldTexts.get(text.id) || randomUUID()]));
            return { ...node, id: ids.get(node.id)!, clientId: node.id, entityId: undefined, ...(node.metadata ? { metadata: { ...node.metadata,
                groupId: node.metadata.groupId ? ids.get(node.metadata.groupId) : undefined, prompt: promptIds(node.metadata.prompt, ids), composerContent: promptIds(node.metadata.composerContent, ids),
                images: node.metadata.images?.map((image) => ({ ...image, id: slots.get(image.id)!, clientId: image.id, entityId: undefined })), primaryImageId: slots.get(node.metadata.primaryImageId || ""),
                texts: node.metadata.texts?.map((text) => ({ ...text, id: texts.get(text.id)!, clientId: text.id, entityId: undefined })), primaryTextId: texts.get(node.metadata.primaryTextId || "") } } : {}) };
        }),
        connections: connections.map((edge) => ({ id: (previous.connections as Array<CanvasConnection & Entity>).find((item) => item.id === edge.id)?.entityId || randomUUID(), clientId: edge.id, fromNodeId: ids.get(edge.fromNodeId)!, toNodeId: ids.get(edge.toNodeId)! })),
    };
}
