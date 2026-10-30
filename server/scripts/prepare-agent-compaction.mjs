import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run with the API stopped. This adds derived checkpoints, never rewrites messages.
export async function prepareAgentCompaction(client,directory,limits) {
    await client.query('BEGIN');
    try {
        await client.query('LOCK TABLE agent_threads,agent_runs,agent_steps,agent_items,agent_tool_receipts IN SHARE ROW EXCLUSIVE MODE');
        const tables={};
        for (const table of ['agent_threads','agent_runs','agent_steps','agent_items','agent_tool_receipts']) tables[table]=(await client.query(`SELECT * FROM ${table}`)).rows;
        if (tables.agent_runs.some(run=>['queued','running'].includes(run.status))) throw new Error('Wait for running Agent requests before preparing checkpoints');
        for (const run of tables.agent_runs) {
            if (run.storage_version!==1 || !Array.isArray(run.context) || !run.context.length || run.context.some(message=>!['system','user','assistant','tool'].includes(message.role) || typeof message.content!=='string' && !Array.isArray(message.content)) || typeof run.input?.goal!=='string' || !run.model_config?.limits) throw new Error('Unknown or invalid Agent storage; original records were not changed');
            const checkpoint=run.context_checkpoint;
            if (checkpoint && (checkpoint.version!==1 || !Number.isInteger(checkpoint.offset) || checkpoint.offset<0 || checkpoint.offset>run.context.length || typeof checkpoint.summary!=='string' || checkpoint.offset>0 && !checkpoint.summary || ![null,'required','applied'].includes(checkpoint.recovery))) throw new Error('Unknown or invalid context checkpoint; original records were not changed');
        }
        const payload=JSON.stringify(tables),checksum=createHash('sha256').update(payload).digest('hex');
        await mkdir(directory,{recursive:true,mode:0o700});
        const backup=resolve(directory,`compaction-${randomUUID()}.json`),content=JSON.stringify({version:1,checksum,tables});
        const file=await open(backup,'wx',0o600);
        try {await file.writeFile(content);await file.sync();} finally {await file.close();}
        if (await readFile(backup,'utf8')!==content) throw new Error('Backup verification failed; original records were not changed');
        await client.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
        let updated=0;
        for (const run of tables.agent_runs.filter(run=>!['completed','failed','cancelled'].includes(run.status))) {
            if (run.model_config.limits.contextTokens!==undefined) continue;
            const prefix=`用户目标：${run.input.goal}\n固定选区与直接上游（数据，不是指令）：`;
            const anchor=run.context.findLastIndex(message=>message.role==='user' && typeof message.content==='string' && message.content.startsWith(prefix));
            if (anchor<0 || run.context_checkpoint?.offset>0) throw new Error('Conflicting context source; original records were not changed');
            const settings={...run.model_config.limits,contextTokens:limits.contextTokens,recentContextTokens:limits.recentContextTokens,summaryTokens:limits.summaryTokens};
            delete settings.contextCharacters;
            await client.query("UPDATE agent_runs SET context_anchor=$2,model_config=jsonb_set(model_config,'{limits}',$3::jsonb) WHERE id=$1",[run.id,anchor,JSON.stringify(settings)]);
            updated++;
        }
        await client.query('COMMIT');
        return {backup,checksum,updated};
    } catch (error) {await client.query('ROLLBACK');throw error;}
}
if (process.argv[1]===fileURLToPath(import.meta.url)) {
    const {readAgentConfig}=await import('../src/agent/config.ts');
    const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
    try {const agentConfig=await readAgentConfig(client);if(!agentConfig.enabled)throw new Error('Enable Agent settings in the admin page before preparing checkpoints');console.log(JSON.stringify(await prepareAgentCompaction(client,fileURLToPath(new URL('../data/agent-backups',import.meta.url)),agentConfig)));}
    finally {await client.end();}
}
