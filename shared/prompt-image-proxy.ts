export function promptImageProxyUrl(value: string, base: string) {
    if (!value || !base) return value;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port || !["raw.githubusercontent.com", "github.com"].includes(url.hostname)) return value;
        return `${base.replace(/\/+$/, "")}/${value}`;
    } catch { return value; }
}
