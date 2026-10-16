import { afterAll, beforeEach, expect, test } from "bun:test";
import { initializeCloud } from "@/services/api/cloud";
import { useCloudStore } from "./use-cloud-store";
import { useAnnouncementStore } from "./use-announcement-store";
import type { AnnouncementDetail } from "../../../shared/announcements";

const originalFetch = globalThis.fetch;
let account = "alice", calls: string[] = [];
let reply: (path: string, init?: RequestInit) => Response | Promise<Response>;
const item = (id: string, revision = "a".repeat(64)) => ({ id, title: `公告${id}`, revision, publishedAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", read: false });
beforeEach(async () => {
    account = "alice"; calls = [];
    useAnnouncementStore.getState().reset();
    useCloudStore.setState({ errors: {}, errorCodes: {} });
    globalThis.fetch = (async (path, init) => {
        const url = String(path);
        if (url.endsWith("/auth/me")) return Response.json({ user: { id: account }, csrf: "test" });
        if (url.endsWith("/channels")) return Response.json({ channels: [] });
        if (url.endsWith("/model-authorization")) return Response.json(null);
        calls.push(url); return reply(url, init);
    }) as typeof fetch;
    await initializeCloud();
});
afterAll(() => { useAnnouncementStore.getState().reset(); globalThis.fetch = originalFetch; });
test("all pages contribute to unread state and overlapping IDs are deduplicated", async () => {
    reply = path => Response.json(path.endsWith("offset=0") ? { items: [item("2")], hasMore: true, nextOffset: 50 } : { items: [item("2"), item("1")], hasMore: false, nextOffset: 100 });
    await useAnnouncementStore.getState().load();
    expect(useAnnouncementStore.getState().items.map(entry => entry.id)).toEqual(["2", "1"]);
    expect(calls.length).toBe(2);
});
test("a late list cannot undo a saved receipt and a new revision remains unread", async () => {
    let complete!: (value: Response) => void;
    reply = (_path, init) => init?.method === "PUT" ? new Response(null, { status: 204 }) : new Promise(resolve => { complete = resolve; });
    const pending = useAnnouncementStore.getState().load();
    const detail: AnnouncementDetail = { ...item("1"), body: "正文" };
    await useAnnouncementStore.getState().markRead(detail, new AbortController().signal);
    complete(Response.json({ items: [item("1")], hasMore: false, nextOffset: 50 }));
    await pending;
    expect(useAnnouncementStore.getState().items[0].read).toBe(true);
    reply = () => Response.json({ items: [item("1", "b".repeat(64))], hasMore: false, nextOffset: 50 });
    await useAnnouncementStore.getState().load();
    expect(useAnnouncementStore.getState().items[0].read).toBe(false);
});
test("account changes and session faults discard pending data and receipts", async () => {
    let complete!: (value: Response) => void;
    reply = () => new Promise(resolve => { complete = resolve; });
    const pending = useAnnouncementStore.getState().load();
    account = "bob"; await initializeCloud();
    complete(Response.json({ items: [item("alice-only")], hasMore: false, nextOffset: 50 }));
    await pending;
    expect(useAnnouncementStore.getState().items).toEqual([]);
    reply = () => new Promise(resolve => { complete = resolve; });
    const late = useAnnouncementStore.getState().load();
    useCloudStore.getState().setError("session", "changed");
    useCloudStore.getState().setError("session");
    complete(Response.json({ items: [item("late")], hasMore: false, nextOffset: 50 }));
    await late;
    expect(useAnnouncementStore.getState().items).toEqual([]);
});
test("service and receipt failures remain local without model authorization or fake empty success", async () => {
    reply = () => Response.json({ error: "ANNOUNCEMENTS_UNAVAILABLE", message: "公告暂不可用" }, { status: 503 });
    await useAnnouncementStore.getState().load();
    expect(useAnnouncementStore.getState().error).toBe("公告暂不可用");
    expect(useCloudStore.getState().errors).toEqual({});
    expect(useCloudStore.getState().modelLoginRequired).toBe(false);
    reply = (_path, init) => init?.method === "PUT" ? Response.json({ error: "ANNOUNCEMENT_CHANGED" }, { status: 409 }) : Response.json({ items: [item("1")], hasMore: false, nextOffset: 50 });
    await useAnnouncementStore.getState().load();
    await expect(useAnnouncementStore.getState().markRead({ ...item("1"), body: "正文" }, new AbortController().signal)).rejects.toThrow();
    expect(useAnnouncementStore.getState().items[0].read).toBe(false);
});
