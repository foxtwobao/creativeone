import { db, transaction } from "./db.js";
import { fileReferences, collectDeletedFiles } from "./storage.js";
import { HttpError } from "./http.js";

export async function readAccountData(userId: string, key: string, fallback: any, namespace = "app_state", client: Pick<typeof db, "query"> = db): Promise<any> {
    const { rows } = await client.query("SELECT value FROM documents WHERE user_id=$1 AND namespace=$2 AND key=$3 AND NOT deleted", [userId, namespace, key]);
    if (!rows[0]) return fallback;
    const value = typeof rows[0].value === "string" ? JSON.parse(rows[0].value) : rows[0].value;
    return value.state ?? value;
}
export async function changeAccountData(userId: string, key: string, fallback: any, change: (current: any) => any, namespace = "app_state") {
    let removed: string[] = [];
    const result = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const current = await readAccountData(userId, key, fallback, namespace, client);
        const next = change(current);
        const refs = fileReferences(next);
        removed = [...fileReferences(current)].filter((key) => !refs.has(key));
        for (const reference of fileReferences(next)) {
            if (!(await client.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [userId, reference])).rowCount) throw new HttpError(409, "FILE_NOT_SYNCED");
        }
        await client.query(`INSERT INTO documents(user_id,namespace,key,value) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,namespace,key) DO UPDATE SET value=EXCLUDED.value,revision=documents.revision+1,deleted=false,updated_at=now()`, [userId, namespace, key, JSON.stringify(JSON.stringify({ state: next, version: 0 }))]);
        return next;
    });
    await collectDeletedFiles(userId, removed).catch(() => console.warn("File cleanup failed"));
    return result;
}
export async function cleanupAccountFiles(userId: string) {
    await collectDeletedFiles(userId);
}
