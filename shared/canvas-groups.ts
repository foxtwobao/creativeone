import type { CanvasConnection, CanvasNodeData } from "../web/src/types/canvas.js";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

function containsCenter(group: CanvasNodeData, node: CanvasNodeData) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === "group")) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== "group");
    if (!movingNodes.length) return null;
    // Walk backwards instead of copying and reversing; this runs on every drag frame.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type !== "group" || movedIds.has(group.id)) continue;
        if (movingNodes.some((node) => containsCenter(group, node))) return group;
    }
    return null;
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== "group");
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === "group") return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export const GROUP_WRAP_PADDING = 24;
export const GROUP_WRAP_TOP_PADDING = 52;

function selectedGroupIds(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    return new Set(nodes.filter((node) => selectedIds.has(node.id) && node.type === "group").map((node) => node.id));
}

export function collectGroupMemberNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    const groups = selectedGroupIds(selectedIds, nodes);
    return nodes.filter((node) => node.type !== "group" && (selectedIds.has(node.id) || (node.metadata?.groupId != null && groups.has(node.metadata.groupId))));
}

export function getGroupWrapRect(members: CanvasNodeData[]) {
    const bounds = nodeBounds(members);
    return {
        x: bounds.left - GROUP_WRAP_PADDING,
        y: bounds.top - GROUP_WRAP_TOP_PADDING,
        width: bounds.right - bounds.left + GROUP_WRAP_PADDING * 2,
        height: bounds.bottom - bounds.top + GROUP_WRAP_TOP_PADDING + GROUP_WRAP_PADDING,
    };
}

export function canGroupSelectedNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    const members = collectGroupMemberNodes(selectedIds, nodes);
    if (members.length < 2) return false;
    const groupId = members[0].metadata?.groupId;
    return !groupId || members.some((node) => node.metadata?.groupId !== groupId);
}

export function canUngroupSelectedNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    return nodes.some((node) => selectedIds.has(node.id) && (node.type === "group" || Boolean(node.metadata?.groupId)));
}

function emptyGroupIds(nodes: CanvasNodeData[], keepId?: string) {
    const used = new Set(nodes.flatMap((node) => (node.type !== "group" && node.metadata?.groupId ? [node.metadata.groupId] : [])));
    return new Set(nodes.filter((node) => node.type === "group" && node.id !== keepId && !used.has(node.id)).map((node) => node.id));
}

function withoutRemoved(nodes: CanvasNodeData[], connections: CanvasConnection[], removedIds: Set<string>) {
    return {
        nodes: nodes.filter((node) => !removedIds.has(node.id)),
        connections: connections.filter((connection) => !removedIds.has(connection.fromNodeId) && !removedIds.has(connection.toNodeId)),
    };
}

export function applyGroupSelection(selectedIds: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[], group: CanvasNodeData) {
    const members = collectGroupMemberNodes(selectedIds, nodes);
    if (members.length < 2) return null;
    const memberIds = new Set(members.map((node) => node.id));
    const flattenedGroupIds = selectedGroupIds(selectedIds, nodes);
    const updated = nodes.filter((node) => !flattenedGroupIds.has(node.id)).map((node) => (memberIds.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId: group.id } } : node));
    const insertAt = updated.findIndex((node) => memberIds.has(node.id));
    const withGroup = insertAt < 0 ? [...updated, group] : [...updated.slice(0, insertAt), group, ...updated.slice(insertAt)];
    const next = withoutRemoved(withGroup, connections, new Set([...flattenedGroupIds, ...emptyGroupIds(withGroup, group.id)]));
    return { ...next, selectedIds: [group.id] };
}

export function applyUngroupSelection(selectedIds: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const flattenedGroupIds = selectedGroupIds(selectedIds, nodes);
    if (!flattenedGroupIds.size && !nodes.some((node) => selectedIds.has(node.id) && node.metadata?.groupId)) return null;
    const releasedIds = new Set<string>();
    const updated = nodes
        .filter((node) => !flattenedGroupIds.has(node.id))
        .map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            if (!flattenedGroupIds.has(groupId) && !selectedIds.has(node.id)) return node;
            releasedIds.add(node.id);
            return { ...node, metadata: { ...node.metadata, groupId: undefined } };
        });
    const next = withoutRemoved(updated, connections, new Set([...flattenedGroupIds, ...emptyGroupIds(updated)]));
    return { ...next, selectedIds: next.nodes.filter((node) => selectedIds.has(node.id) || releasedIds.has(node.id)).map((node) => node.id) };
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    // Called once per moved node when a drag ends, so avoid copying the node list each time.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type === "group" && group.id !== node.id && containsCenter(group, node)) return group.id;
    }
    return undefined;
}

