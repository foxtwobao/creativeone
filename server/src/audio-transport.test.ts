import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { audioDispatcher, AUDIO_REQUEST_TIMEOUT_MS } from "./audio.js";

// Undici exposes this clock specifically for transport tests; no wall-clock wait or model call.
const timers = createRequire(import.meta.url)("undici/lib/util/timers.js");
after(async () => { await audioDispatcher.destroy(); timers.reset(); });

for (const phase of ["headers", "body"] as const) {
    test(`audio ${phase} can arrive after eleven minutes`, async () => {
        let received!: (response: ServerResponse) => void;
        const ready = new Promise<ServerResponse>((resolve) => { received = resolve; });
        const server = createServer((_request, response) => {
            if (phase === "body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"ok":'); }
            received(response);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const headers = fetch(`http://127.0.0.1:${(server.address() as any).port}`, { ...{ dispatcher: audioDispatcher } });
            const pending = headers.then((response) => response.json());
            let settled = false;
            void pending.then(() => { settled = true; }, () => { settled = true; });
            const response = await ready;
            if (phase === "body") await headers;
            await setImmediate();
            timers.tick();
            timers.tick(11 * 60_000);
            await setImmediate();
            assert.equal(settled, false);
            response.end(phase === "body" ? "true}" : '{"ok":true}');
            assert.deepEqual(await pending, { ok: true });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test(`audio ${phase} stops after the approved fifteen minutes`, async () => {
        let received!: () => void, requests = 0;
        const ready = new Promise<void>((resolve) => { received = resolve; });
        const server = createServer((_request, response) => {
            requests++;
            if (phase === "body") { response.writeHead(200); response.write('{"ok":'); }
            received();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const headers = fetch(`http://127.0.0.1:${(server.address() as any).port}`, { ...{ dispatcher: audioDispatcher } });
            const pending = headers.then((response) => response.json());
            const rejected = assert.rejects(pending, (error: any) => error.cause?.code === (phase === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT"));
            await ready;
            if (phase === "body") await headers;
            await setImmediate();
            timers.tick();
            assert.equal(AUDIO_REQUEST_TIMEOUT_MS, 900_000);
            timers.tick(AUDIO_REQUEST_TIMEOUT_MS + 1_000);
            await rejected;
            assert.equal(requests, 1);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}
