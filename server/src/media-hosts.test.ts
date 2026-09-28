import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedMediaUrl } from "./media-hosts.js";

test("star allows HTTPS result hosts but retains transport restrictions", () => {
    const result = new URL("https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/image");
    assert.equal(isAllowedMediaUrl(result, []), false);
    assert.equal(isAllowedMediaUrl(result, [" * "]), true);
    for (const url of ["http://cdn.example.com/image", "https://user:pass@cdn.example.com/image", "file:///image"]) {
        assert.equal(isAllowedMediaUrl(new URL(url), ["*"]), false);
    }
});

test("wildcards allow the root and nested subdomains", () => {
    for (const host of ["volces.com", "cdn.volces.com", "ark.tos.volces.com"]) {
        assert.equal(isAllowedMediaUrl(new URL(`https://${host}/video.mp4`), ["*.volces.com"]), true);
    }
    assert.equal(isAllowedMediaUrl(new URL("https://cdn.volcengine.com/video.mp4"), ["*.volces.com", "*.volcengine.com"]), true);
});
test("wildcards respect domain boundaries and transport restrictions", () => {
    for (const url of ["https://evilvolces.com/a", "https://volces.com.evil.com/a", "https://volces.com:8443/a", "http://cdn.volces.com/a", "https://user:pass@cdn.volces.com/a"]) {
        assert.equal(isAllowedMediaUrl(new URL(url), ["*.volces.com"]), false);
    }
});
test("exact hosts and explicit ports remain supported", () => {
    assert.equal(isAllowedMediaUrl(new URL("https://cdn.example.com:8443/a"), [" CDN.EXAMPLE.COM:8443 "]), true);
    assert.equal(isAllowedMediaUrl(new URL("https://sub.cdn.example.com/a"), ["cdn.example.com"]), false);
    assert.equal(isAllowedMediaUrl(new URL("https://sub.volces.com:8443/a"), ["*.volces.com:8443"]), true);
    assert.equal(isAllowedMediaUrl(new URL("https://volces.com/a"), ["*.", ""]), false);
});
