import { z } from "zod";
import { agentPhases } from "../../../shared/agent.js";
import { HttpError } from "../http.js";
import { getNode, type Client, type Run } from "./state.js";
import { findCanvasProject } from "../business.js";

export const creativeStateSchema=z.object({phase:z.enum(Object.keys(agentPhases) as [keyof typeof agentPhases,...Array<keyof typeof agentPhases>]),brief:z.string().optional(),approvedPlan:z.string().optional(),targetDurationSeconds:z.number().positive().optional(),approvedNodeIds:z.array(z.string()).optional(),referenceNodeIds:z.array(z.string()).optional()}).strict();
export async function readCreativeState(client:Client,threadId:string) {return (await client.query("SELECT state FROM agent_creative_states WHERE thread_id=$1",[threadId])).rows[0]?.state || null;}
export async function saveCreativeState(client:Client,run:Run,value:unknown) {
    const input=creativeStateSchema.parse(value),project=await findCanvasProject(run.user_id,run.project_id,client),state={...await readCreativeState(client,run.thread_id),...input};
    for (const field of ["approvedNodeIds","referenceNodeIds"]) if (input[field as keyof typeof input]) state[field]=(input[field as keyof typeof input] as string[]).map(id => {const node=getNode(project,id);return node.entityId || node.id;});
    if (!Object.hasOwn(agentPhases,state.phase)) throw new HttpError(400,"INVALID_REQUEST");
    await client.query("INSERT INTO agent_creative_states(thread_id,state) VALUES($1,$2) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,updated_at=now()",[run.thread_id,JSON.stringify(state)]);return state;
}
