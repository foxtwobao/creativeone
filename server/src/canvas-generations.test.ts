import { test } from "node:test";
import assert from "node:assert/strict";
import { isCanvasMediaReplacement, preserveCanvasGeneration } from "../../shared/canvas-generations.js";
import { canvasGraphView, persistCanvasGraph } from "./canvas-graph.js";
import { archiveCanvasNode, canvasArchiveMediaValid, remapCanvasGraph } from "../../shared/canvas-archive.js";
import type { CanvasNodeData } from "../../web/src/types/canvas.js";

const output: CanvasNodeData = { id: "node", type: "image", title: "output", position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { generationId: "operation", generationTaskId: "task", status: "success", content: "/api/files/image_files/a", storageKey: "a" } };
test("an old undo snapshot preserves the confirmed result while applying geometry and title edits", () => {
    const next = preserveCanvasGeneration({ ...output, title: "edited", width: 240, metadata: { generationId: "operation", status: "loading" } }, output);
    assert.equal(next.title, "edited");
    assert.equal(next.width, 240);
    assert.equal(next.metadata?.status, "success");
    assert.equal(next.metadata?.content, output.metadata?.content);
});
test("a new explicit generation can replace the previous operation", () => {
    const next = preserveCanvasGeneration({ ...output, metadata: { generationId: "new-operation", status: "loading" } }, output);
    assert.equal(next.metadata?.generationId, "new-operation");
    assert.equal(next.metadata?.content, undefined);
});
test("failure before task acceptance remains editable", () => {
    const unsent = { ...output, metadata: { generationId: "unsent", status: "loading" as const } };
    const next = preserveCanvasGeneration({ ...unsent, metadata: { ...unsent.metadata, status: "error", errorDetails: "authorization required" } }, unsent);
    assert.equal(next.metadata?.status, "error");
});
test("unchanged result fields retain the incoming node even when metadata key order differs", () => {
    const incoming: CanvasNodeData = { ...output, metadata: { status: "success", storageKey: "a", content: output.metadata!.content, generationTaskId: "task", generationId: "operation" } };
    assert.equal(preserveCanvasGeneration(incoming, output), incoming);
});
test("a stale edit cannot roll a completed result back and merging the confirmed result settles", () => {
    const stale: CanvasNodeData = { ...output, title: "edited while running", position: { x: 12, y: 24 }, metadata: { generationId: "operation", generationTaskId: "task", status: "loading" } };
    const merged = preserveCanvasGeneration(stale, output);
    assert.equal(merged.metadata?.status, "success");
    assert.equal(merged.title, stale.title);
    assert.deepEqual(merged.position, stale.position);
    assert.equal(preserveCanvasGeneration(merged, output), merged);
});
test("an explicit upload replacement is distinguished from completion of the current generation", () => {
    const uploaded: CanvasNodeData = { ...output, metadata: { storageKey: "image:uploaded", content: "/api/files/image_files/image%3Auploaded", status: "success" } };
    assert.equal(isCanvasMediaReplacement(uploaded, output), true);
    const completed: CanvasNodeData = { ...output, metadata: { ...output.metadata, storageKey: "image:generated" } };
    assert.equal(isCanvasMediaReplacement(completed, output), false);
});
test("batch slots preserve their own results and keep an explicit primary selection", () => {
    const image = (id: string) => ({ id, generationId: `operation-${id}`, generationTaskId: `task-${id}`, status: "success" as const, content: `/api/files/image_files/${id}`, storageKey: id, naturalWidth: 1024, naturalHeight: 1024, bytes: 10, mimeType: "image/png" });
    const saved = { ...output, metadata: { images: [image("a"), image("b")], primaryImageId: "a", status: "success" as const } };
    const stale = { ...saved, metadata: { ...saved.metadata, primaryImageId: "b", images: saved.metadata.images.map((item) => ({ ...item, status: "loading" as const, content: "" })) } };
    const next = preserveCanvasGeneration(stale, saved);
    assert.equal(next.metadata?.primaryImageId, "b");
    assert.equal(next.metadata?.content, "/api/files/image_files/b");
    assert.ok(next.metadata?.images?.every((item) => item.status === "success"));
    const undo = preserveCanvasGeneration({ ...stale, metadata: { ...stale.metadata, primaryImageId: undefined } }, next);
    assert.equal(undo.metadata?.primaryImageId, "b");
});
test("server entity IDs survive edits while forged IDs cannot choose persisted identities", () => {
    const node = { ...output, entityId: "forged", metadata: { ...output.metadata, images: [{ id: "slot", entityId: "forged-slot", content: "", status: "idle" as const, naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "image/png" }], primaryImageId: "slot", prompt: "@[node:node]" } };
    const persisted = persistCanvasGraph([node], [], { nodes: [], connections: [] });
    assert.notEqual(persisted.nodes[0].id, "forged");
    assert.notEqual(persisted.nodes[0].metadata?.images?.[0].id, "forged-slot");
    assert.equal(persisted.nodes[0].metadata?.prompt, `@[node:${persisted.nodes[0].id}]`);
    const view = canvasGraphView(persisted.nodes, persisted.connections);
    assert.equal(view.nodes[0].id, "node");
    assert.equal(view.nodes[0].metadata?.primaryImageId, "slot");
    const edited = persistCanvasGraph([{ ...view.nodes[0], title: "renamed" }], [], view);
    assert.equal(edited.nodes[0].id, persisted.nodes[0].id);
    assert.equal(edited.nodes[0].metadata?.images?.[0].id, persisted.nodes[0].metadata?.images?.[0].id);
});
test("archives remap groups, mentions and slots without importing credentials or task state", () => {
    const group = { ...output, id: "group", type: "group", metadata: {} };
    const node = { ...output, metadata: { ...output.metadata, storageKey: "image:owned", groupId: "group", prompt: "@[node:group]", apiKey: "secret", script: "execute()", images: [{ id: "slot", generationId: "operation", generationTaskId: "task", status: "loading" as const, storageKey: "image:owned", content: "old", naturalWidth: 1, naturalHeight: 1, bytes: 10, mimeType: "image/png" }], primaryImageId: "slot" } };
    const clean = archiveCanvasNode(node);
    assert.ok(!JSON.stringify(clean).includes("secret"));
    assert.ok(!JSON.stringify(clean).includes("execute()"));
    assert.equal(clean.metadata?.generationTaskId, undefined);
    assert.equal(clean.metadata?.images?.[0].status, "success");
    let sequence = 0;
    const imported = remapCanvasGraph([group, node], [{ id: "edge", fromNodeId: "group", toNodeId: "node" }], () => `new-${sequence++}`);
    assert.equal(imported.nodes[1].metadata?.groupId, imported.nodes[0].id);
    assert.equal(imported.nodes[1].metadata?.prompt, `@[node:${imported.nodes[0].id}]`);
    assert.equal(imported.connections[0].toNodeId, imported.nodes[1].id);
    assert.equal(imported.nodes[1].metadata?.primaryImageId, imported.nodes[1].metadata?.images?.[0].id);
    assert.ok(!canvasArchiveMediaValid([{ ...node, metadata: { references: ["https://example.com/public/media/id?signature=secret"] } }]));
    assert.ok(!canvasArchiveMediaValid([{ ...node, metadata: { content: "data:image/png;base64,abc" } }]));
});

test("copying an active generation produces independent idle nodes and remapped mentions", () => {
    const source: CanvasNodeData = { ...output, metadata: { ...output.metadata, status: "loading", content: "", storageKey: undefined,
        prompt: "@[node:node]", videoTaskId: "upstream", images: [{ id: "slot", generationId: "running", generationTaskId: "task", status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }] } };
    let sequence = 0;
    const copy = remapCanvasGraph([source], [], () => `copy-${sequence++}`).nodes[0];
    assert.equal(copy.metadata?.status, "idle");
    assert.equal(copy.metadata?.images?.[0].status, "idle");
    assert.equal(copy.metadata?.generationId, undefined);
    assert.equal(copy.metadata?.videoTaskId, undefined);
    assert.equal(copy.metadata?.images?.[0].generationId, undefined);
    assert.equal(copy.metadata?.prompt, `@[node:${copy.id}]`);
    assert.equal(source.metadata?.status, "loading");
});
