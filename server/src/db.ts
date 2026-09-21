import pg from "pg";
import { readFile } from "node:fs/promises";
import { env } from "./config.js";

export const db = new pg.Pool({ connectionString: env.DATABASE_URL });
export async function initializeDatabase() {
    await db.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
}
export async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await run(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
}
