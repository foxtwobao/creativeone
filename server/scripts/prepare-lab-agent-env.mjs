import { readFile, writeFile, chmod } from "node:fs/promises";
import { parseEnv } from "node:util";

// Refresh Docker's environment from the lab server configuration before each start.
const values = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const database = new URL(values.DATABASE_URL);
if (database.hostname !== "127.0.0.1" || database.port !== "5433") {
    throw new Error("Review the lab PostgreSQL container mapping before changing DATABASE_URL");
}
database.hostname = "creativeone-local-postgres";
database.port = "5432";
Object.assign(values, {
    DATABASE_URL: database.href,
    MEDIA_DIR: "/app/data/media",
    NODE_ENV: "production",
    AGENT_WORKER_MODE: "external",
    NODE_EXTRA_CA_CERTS: "/etc/creativeone/lab-root.crt",
});

for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`Docker env file cannot represent multiline field ${name}`);
}
const destination = new URL("../data/lab-agent-container.env", import.meta.url);
await writeFile(destination, Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n") + "\n", { mode: 0o600 });
await chmod(destination, 0o600);
