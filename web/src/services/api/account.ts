import { cloudApi } from "./cloud";

// Serialize reads and mutations of one account resource so an older response cannot replace newer page state.
const pending = new Map<string, Promise<unknown>>();
const reads = new Map<string, { path: string; result: Promise<unknown> }>();
function request<T>(path: string, init?: RequestInit): Promise<T> {
    const resource = path.startsWith("/prompt-schedule") ? "prompt-sources" : path.split("/")[1];
    const read = reads.get(resource);
    if (!init && read?.path === path) return read.result as Promise<T>;
    // A queued mutation separates reads, so a later read sees the saved value.
    reads.delete(resource);
    const result = (pending.get(resource) || Promise.resolve()).then(() => cloudApi<T>(path, init));
    pending.set(resource, result.catch(() => undefined));
    if (!init) {
        reads.set(resource, { path, result });
        const clear = () => { if (reads.get(resource)?.result === result) reads.delete(resource); };
        void result.then(clear, clear);
    }
    return result;
}
export const getAccountResource = <T>(path: string) => request<T>(path);
export const changeAccountResource = <T>(path: string, body: unknown, method = "PATCH") => request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
