import type { CanvasNodeData, CanvasConnection } from "../web/src/types/canvas.js";

// Audio creation reads text only. Other connected media are never hydrated or sent upstream.
export function canvasAudioText(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const plain = (text: string) => text.replace(/@\[node:[^\]]+\]/g, "").trim();
    const targetPrompt = plain(nodes.find((item) => item.id === nodeId)?.metadata?.prompt || "");
    const texts: string[] = [], visited = new Set([nodeId]);
    const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (!node) return;
        if (node.type === "text" && node.metadata?.content?.trim()) texts.push(node.metadata.content.trim());
        if (node.type === "group") for (const child of nodes.filter((item) => item.metadata?.groupId === id)) visit(child.id);
        if (node.type === "config") {
            const prompt = node.metadata?.composerContent || node.metadata?.prompt;
            if (prompt?.trim() && plain(prompt) !== targetPrompt) texts.push(plain(prompt));
            const mentions = [...(prompt || "").matchAll(/@\[node:([^\]]+)\]/g)].map((match) => match[1]);
            for (const connection of connections.filter((edge) => edge.toNodeId === id && (!mentions.length || mentions.includes(edge.fromNodeId)))) visit(connection.fromNodeId);
        }
    };
    for (const connection of connections.filter((edge) => edge.toNodeId === nodeId)) visit(connection.fromNodeId);
    return texts.filter(Boolean).map((text, index) => `【文本 ${index + 1}】\n${text}`).join("\n\n");
}
