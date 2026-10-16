import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const settings = {
    NODE_ENV: "production", DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test","https://ccpg.test"]', APP_DOMAIN_SUFFIXES: "", ENHANCER_BASE_URL: "https://reseller.test",
    RESELLER_APP_ID: "creativeone", IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "",
    IDONE_CLIENT_ID: "creativeone", IDONE_CLIENT_SECRET: "test-secret", ADMIN_SUBJECTS: "admin",
};
const load = (overrides: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { env, loginSites, resolveLoginSite } = await import('./src/config.ts');
    console.log(JSON.stringify({ origins: [...loginSites.values()].map(site => site.origin), reseller: env.ENHANCER_BASE_URL, appId: env.RESELLER_APP_ID,
        ...(process.env.TEST_HOSTS ? { sites: JSON.parse(process.env.TEST_HOSTS).map(host => resolveLoginSite(host)?.origin ?? null) } : {}) }));
`], { cwd: new URL("..", import.meta.url), env: { ...process.env, ...settings, ...overrides }, encoding: "utf8" });

test("existing Reseller origin and exact public origins are independent", () => {
    const result = load();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { origins: ["https://app.test", "https://ccpg.test"], reseller: "https://reseller.test", appId: "creativeone" });
});

test("reject invalid or ambiguous origins instead of accepting arbitrary callback origins", () => {
    for (const overrides of [
        { RESELLER_APP_ID: "admin/creativeone" }, { RESELLER_APP_ID: "" }, { RESELLER_APP_ID: "CreativeONE" },
        { APP_ORIGINS: "{}" }, { APP_ORIGINS: "[]" },
        { APP_ORIGINS: '["https://ccpg.test"]' }, { APP_ORIGINS: '["https://app.test","https://app.test"]' },
        { APP_ORIGINS: '["https://app.test","http://app.test"]' }, { APP_ORIGINS: '["https://app.test/"]' },
        { APP_ORIGINS: '["https://app.test","https://*.example.com"]' },
        { ENHANCER_BASE_URL: "https://reseller.test/auth/login" }, { ENHANCER_BASE_URL: "https://reseller.test/" },
        { ENHANCER_BASE_URL: "https://reseller.test?site=ccpg" }, { ENHANCER_BASE_URL: "https://user:password@reseller.test" },
        { ENHANCER_BASE_URL: "http://reseller.test" }, { ENHANCER_BASE_URL: "" },
    ]) assert.notEqual(load(overrides).status, 0, JSON.stringify(overrides));
});

test("domain suffixes allow multiple levels and reject unrelated or malformed hosts", () => {
    const result = load({ APP_ORIGINS: "", APP_DOMAIN_SUFFIXES: "example.com, example.org", TEST_HOSTS: JSON.stringify([
        "app.test", "example.com", "creative.example.com", "creative.ccpg.example.com", "creative.example.org",
        "fakeexample.com", "example.com.evil.test", "creative.example.com:444", "user@creative.example.com",
        "creative.example.com/path", "creative.example.com?query", "creative.example.com.", "",
    ]) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).sites, [
        "https://app.test", "https://example.com", "https://creative.example.com", "https://creative.ccpg.example.com", "https://creative.example.org",
        null, null, null, null, null, null, null, null,
    ]);
    for (const suffix of ["https://example.com", "*.example.com", ".example.com", "example.com:444", "example.com/path", "EXAMPLE.COM", "com"]) {
        assert.notEqual(load({ APP_DOMAIN_SUFFIXES: suffix }).status, 0, suffix);
    }
});

test("only development loopback origins can use HTTP", () => {
    const local = { APP_ORIGIN: "http://localhost:3001", APP_ORIGINS: '["http://localhost:3001"]', ENHANCER_BASE_URL: "http://127.0.0.1:3000" };
    assert.equal(load({ ...local, NODE_ENV: "development" }).status, 0);
    assert.notEqual(load(local).status, 0);
    assert.notEqual(load({ ...local, NODE_ENV: "development", APP_ORIGINS: '["http://localhost:3001","http://192.168.1.2"]' }).status, 0);
});
