import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(environment: string, allow: string, script: string) {
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: new URL("../", import.meta.url), encoding: "utf8",
        env: { ...process.env, NODE_ENV: environment, DEV_AUTO_CREATE_TOKENONE_USER: allow,
            DATABASE_URL: "postgresql://unused:unused@localhost/unused", APP_ORIGIN: "https://app.test",
            IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test",
            ADMIN_SUBJECTS: "admin", ENHANCER_BASE_URL: "https://enhancer.test", ENHANCER_INTERNAL_SECRET: "test", TOKENONE_BASE_URL: "https://tokenone.test" },
    });
}

test("account creation opt-in is rejected outside explicit development", () => {
    for (const environment of ["production", "test", ""]) {
        const result = run(environment, "true", 'await import("./src/config.ts")');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /only allowed with NODE_ENV=development/);
    }
});

test("Key request explicitly carries creation policy and missing account has a safe message", () => {
    for (const [environment, allow] of [["production", "false"], ["development", "false"], ["development", "true"]]) {
        const result = run(environment, allow, `
            import assert from 'node:assert/strict';
            const { ensureKey } = await import('./src/tokenone.ts');
            const { modelErrorMessage } = await import('./src/model-errors.ts');
            let calls = 0;
            globalThis.fetch = async (url, init) => {
                calls++;
                assert.equal(url, 'https://enhancer.test/internal/tokenone/api-key/ensure');
                assert.equal(JSON.parse(init.body).allow_user_creation, ${allow});
                return Response.json({ error: 'TOKENONE_USER_NOT_FOUND' }, { status: 503 });
            };
            await assert.rejects(ensureKey({ email_verified: true, issuer: 'https://idone.test', subject: 'user', email: 'user@example.test', username: 'user' }, 8, 'request-test'), { code: 'TOKENONE_USER_NOT_FOUND', status: 503 });
            assert.equal(calls, 1);
            assert.match(modelErrorMessage('TOKENONE_USER_NOT_FOUND'), /账号尚未同步/);
        `);
        assert.equal(result.status, 0, result.stderr);
    }
});
