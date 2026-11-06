import { z } from "zod";
import { agentPhases } from "../../../shared/agent.js";
import { HttpError } from "../http.js";
import { getNode, type Client, type Run } from "./state.js";
import { findCanvasProject } from "../business.js";

export const creativeStateSchema=z.object({phase:z.enum(Object.keys(agentPhases) as [keyof typeof agentPhases,...Array<keyof typeof agentPhases>]).describe(`固定阶段标识与含义：${JSON.stringify(agentPhases)}；必须使用标识，不用中文或自造阶段。`),brief:z.string().nullish(),approvedPlan:z.string().nullish(),targetDurationSeconds:z.number().positive().nullish().describe("目标总时长，单位秒，使用正数，例如 15；未知或保留已有值时填 null，不传字符串。"),approvedNodeIds:z.array(z.string()).nullish(),referenceNodeIds:z.array(z.string()).nullish()}).strict();
export async function readCreativeState(client:Client,threadId:string) {return (await client.query("SELECT state FROM agent_creative_states WHERE thread_id=$1",[threadId])).rows[0]?.state || null;}
export async function saveCreativeState(client:Client,run:Run,value:unknown) {
    const input=creativeStateSchema.parse(value),project=await findCanvasProject(run.user_id,run.project_id,client),state={...await readCreativeState(client,run.thread_id),...Object.fromEntries(Object.entries(input).filter(([,value])=>value!=null))};
    for (const field of ["approvedNodeIds","referenceNodeIds"]) if (input[field as keyof typeof input]) state[field]=(input[field as keyof typeof input] as string[]).map(id => {const node=getNode(project,id);return node.entityId || node.id;});
    if (!Object.hasOwn(agentPhases,state.phase)) throw new HttpError(400,"INVALID_REQUEST");
    await client.query("INSERT INTO agent_creative_states(thread_id,state) VALUES($1,$2) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,updated_at=now()",[run.thread_id,JSON.stringify(state)]);return state;
}
