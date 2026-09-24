/** Wildcards include the root host and subdomains, with the configured port. */
export function isAllowedMediaUrl(url: URL, rules: Iterable<string>) {
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return Array.from(rules).some((value) => {
        const rule = value.trim().toLowerCase();
        if (!rule.startsWith("*.")) return url.host === rule;
        const root = rule.slice(2);
        return Boolean(root) && !root.includes("*") && (url.host === root || url.host.endsWith(`.${root}`));
    });
}
