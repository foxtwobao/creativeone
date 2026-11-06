import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

export async function queuePiInput(client:Pick<PoolClient,"query">,run:{id:string;thread_id:string},content:unknown,id=randomUUID()) {
    await client.query("INSERT INTO agent_pi_inputs(id,thread_id,turn_id,content) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",[id,run.thread_id,run.id,JSON.stringify(content)]);
}
