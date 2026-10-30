import { z } from "zod";
import { db,transaction } from "../db.js";
import { HttpError } from "../http.js";
import { agentSettingsDefaults,type AgentSettingsRecord } from "../../../shared/agent-settings.js";
import type { PoolClient } from "pg";

const positive=z.number().int().positive();
const settingsShape={enabled:z.boolean(),globalConcurrency:positive,accountConcurrency:positive,inputCharacters:positive,
    decisionBudget:positive,contextTokens:positive,recentContextTokens:positive,summaryTokens:positive,outputTokens:positive.nullable(),
    nodeBatch:positive,mediaBatch:positive,requestTimeoutMs:positive,scanIntervalMs:positive,pollIntervalMs:positive};
export const agentSettingsSchema=z.object(settingsShape).strict().superRefine((value,ctx)=>{
    if(value.accountConcurrency>value.globalConcurrency)ctx.addIssue({code:"custom",path:["accountConcurrency"],message:"单账号并发不能超过全局并发"});
    if(value.recentContextTokens+value.summaryTokens>=value.contextTokens)ctx.addIssue({code:"custom",path:["contextTokens"],message:"压缩触发量必须大于近期保留量与摘要预算之和"});
});
export const agentConfigSchema=z.object({...settingsShape,outputTokens:positive.optional(),
    verifiedModels:z.array(z.object({model:z.string(),protocol:z.literal("responses"),imageInput:z.boolean()}).strict()),verifiedMediaModels:z.array(z.string()),
}).strict();
export type AgentConfig=z.infer<typeof agentConfigSchema>;
type Client=Pick<PoolClient,"query">;
export async function readAgentSettings(client:Client=db):Promise<AgentSettingsRecord>{
    const row=(await client.query("SELECT value,revision FROM agent_settings WHERE id=true")).rows[0];
    return {...agentSettingsSchema.parse(row?row.value:agentSettingsDefaults),revision:row?Number(row.revision):0};
}
export async function saveAgentSettings(value:unknown){
    const input=z.object({revision:z.number().int().nonnegative(),...settingsShape}).strict().parse(value),{revision,...settings}=input;
    agentSettingsSchema.parse(settings);
    return transaction(async client=>{
        const saved=revision===0 ? await client.query("INSERT INTO agent_settings(id,value) VALUES(true,$1) ON CONFLICT DO NOTHING RETURNING revision",[JSON.stringify(settings)])
            : await client.query("UPDATE agent_settings SET value=$1,revision=revision+1,updated_at=now() WHERE id=true AND revision=$2 RETURNING revision",[JSON.stringify(settings),revision]);
        if(!saved.rowCount)throw new HttpError(409,"AGENT_CONFIG_CHANGED");
        return {...settings,revision:Number(saved.rows[0].revision)};
    });
}
export async function readAgentConfig(client:Client=db):Promise<AgentConfig>{
    const [{revision,...settings},channels]=await Promise.all([readAgentSettings(client),client.query("SELECT capability,models,model_capabilities FROM channels WHERE enabled ORDER BY capability")]);
    const verifiedModels=channels.rows.filter(row=>row.capability==="text").flatMap(row=>row.models.filter((model:string)=>row.model_capabilities[model]?.agentEnabled===true).map((model:string)=>({model,protocol:"responses" as const,imageInput:row.model_capabilities[model].imageInput===true})));
    const verifiedMediaModels=channels.rows.filter(row=>row.capability!=="text").flatMap(row=>row.models.filter((model:string)=>row.model_capabilities[model]?.agentEnabled===true));
    return agentConfigSchema.parse({...settings,outputTokens:settings.outputTokens??undefined,verifiedModels,verifiedMediaModels});
}
export const AGENT_PROTOCOL_VERSION=1;
export const AGENT_STORAGE_VERSION=1;
