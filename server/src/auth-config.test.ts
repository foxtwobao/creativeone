import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const settings = {
    NODE_ENV: "production", DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test","https://ccpg.test"]', HOMEONE_LOGIN_ORIGIN: "https://home.test",
    IDONE_APP: "admin/creativeone", IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "",
    IDONE_CLIENT_ID: "creativeone", IDONE_CLIENT_SECRET: "test-secret", ADMIN_SUBJECTS: "admin",
};
const load = (overrides: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { env, loginSites } = await import('./src/config.ts');
    console.log(JSON.stringify({ origins: [...loginSites.values()].map(site => site.origin), home: env.HOMEONE_LOGIN_ORIGIN }));
`], { cwd: new URL("..", import.meta.url), env: { ...process.env, ...settings, ...overrides }, encoding: "utf8" });

test("fixed HomeONE origin and exact public origins are independent", () => {
    const result = load();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { origins: ["https://app.test", "https://ccpg.test"], home: "https://home.test" });
});

test("reject invalid or ambiguous origins instead of falling back to the old site mapping", () => {
    for (const overrides of [
        { APP_ORIGINS: "" }, { APP_ORIGINS: "{}" }, { APP_ORIGINS: "[]" },
        { APP_ORIGINS: '["https://ccpg.test"]' }, { APP_ORIGINS: '["https://app.test","https://app.test"]' },
        { APP_ORIGINS: '["https://app.test","http://app.test"]' }, { APP_ORIGINS: '["https://app.test/"]' },
        { APP_ORIGINS: '["https://app.test","https://*.example.com"]' },
        { HOMEONE_LOGIN_ORIGIN: "https://home.test/auth/login" }, { HOMEONE_LOGIN_ORIGIN: "https://home.test/" },
        { HOMEONE_LOGIN_ORIGIN: "https://home.test?site=ccpg" }, { HOMEONE_LOGIN_ORIGIN: "https://user:password@home.test" },
        { HOMEONE_LOGIN_ORIGIN: "http://home.test" }, { HOMEONE_LOGIN_ORIGIN: "" },
        { APP_ORIGINS: "", HOMEONE_SITES: '{"https://app.test":"https://home.test"}' },
    ]) assert.notEqual(load(overrides).status, 0, JSON.stringify(overrides));
});

test("only development loopback origins can use HTTP", () => {
    const local = { APP_ORIGIN: "http://localhost:3001", APP_ORIGINS: '["http://localhost:3001"]', HOMEONE_LOGIN_ORIGIN: "http://127.0.0.1:3000" };
    assert.equal(load({ ...local, NODE_ENV: "development" }).status, 0);
    assert.notEqual(load(local).status, 0);
    assert.notEqual(load({ ...local, NODE_ENV: "development", APP_ORIGINS: '["http://localhost:3001","http://192.168.1.2"]' }).status, 0);
});
