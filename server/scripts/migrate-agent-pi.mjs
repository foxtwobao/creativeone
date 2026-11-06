import pg from 'pg';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,open,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { creativePiTools } from '../src/agent/pi-tools.ts';
import { validatePiSnapshot } from '../src/agent/pi-session.ts';
import { coreRules,nodeRules } from '../src/agent/skills.ts';
import { inlineStoredFile } from '../src/storage.ts';
import { deduplicateToolResults } from '../src/agent/memory.ts';

const signature=createHash('sha256').update(JSON.stringify(creativePiTools(async()=>({content:[]})).map(({name,description,parameters})=>({name,description,parameters})))).digest('hex');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export async function convertLegacyMessage(message,run){
    if(!['system','user','assistant','tool'].includes(message.role)||typeof message.content!=='string'&&!Array.isArray(message.content))throw new Error('Unknown legacy message');
    if(message.role==='system')return [{role:'system',content:message.content,timestamp:0}];
    if(message.role==='tool')return message.content.map(part=>{
        if(part.type!=='tool-result'||!part.toolCallId||!part.toolName)throw new Error('Invalid legacy result');
        return {role:'toolResult',toolCallId:part.toolCallId,toolName:part.toolName,content:[{type:'text',text:part.output?.type==='json'?JSON.stringify(part.output.value):String(part.output?.value??'')}],isError:Boolean(part.output?.value?.error),timestamp:0};
    });
    const content=[];
    for(const part of typeof message.content==='string'?[{type:'text',text:message.content}]:message.content){
        if(part.type==='text')content.push(part);
        else if(part.type==='tool-call')content.push({type:'toolCall',id:part.toolCallId,name:part.toolName,arguments:part.input});
        else if(part.type==='reasoning')content.push({type:'thinking',thinking:part.text});
        else if(part.type==='image'){
            const inline=await inlineStoredFile(run.user_id,part.image),match=/^data:([^;]+);base64,(.*)$/s.exec(inline);
            if(!match)throw new Error('Invalid legacy image');content.push({type:'image',mimeType:match[1],data:match[2]});
        }else throw new Error('Unknown legacy content');
    }
    return [{role:message.role,content,timestamp:0,...message.role==='assistant'?{api:'openai-responses',provider:'creativeone',model:run.model_config.model,stopReason:content.some(part=>part.type==='toolCall')?'toolUse':'stop',usage}:{}}];
}

// Stop API/worker before running. Backup is fsynced and checked before any migration write.
export async function migrateAgentPi(client,directory){
    await client.query('BEGIN');
    try{
        await client.query('LOCK TABLE agent_threads,agent_runs,agent_steps,agent_items,agent_tool_receipts IN SHARE ROW EXCLUSIVE MODE');
        const tables={};
        for(const name of ['agent_threads','agent_runs','agent_steps','agent_items','agent_tool_receipts','agent_pi_sessions','agent_pi_entries','agent_pi_inputs','agent_pi_pending']){
            tables[name]=(await client.query('SELECT to_regclass($1) AS name',[name])).rows[0].name?(await client.query(`SELECT * FROM ${name}`)).rows:[];
        }
        if(tables.agent_runs.some(run=>![1,2].includes(run.storage_version)))throw new Error('Unknown storage version; originals untouched');
        if(tables.agent_runs.some(run=>run.storage_version===1&&run.context_checkpoint?.version!==1))throw new Error('Unknown legacy checkpoint; originals untouched');
        const payload=JSON.stringify(tables),checksum=createHash('sha256').update(payload).digest('hex');
        await mkdir(directory,{recursive:true,mode:0o700});
        const backup=resolve(directory,`pi-migration-${randomUUID()}.json`),body=JSON.stringify({version:1,checksum,tables});
        const file=await open(backup,'wx',0o600);try{await file.writeFile(body);await file.sync();}finally{await file.close();}
        if(await readFile(backup,'utf8')!==body)throw new Error('Backup verification failed');
        await client.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
        let migrated=0;
        for(const thread of tables.agent_threads){
            const runs=tables.agent_runs.filter(run=>run.thread_id===thread.id).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)||a.id.localeCompare(b.id));
            if(!runs.some(run=>run.storage_version===1))continue;
            if(runs.some(run=>run.storage_version!==1)||tables.agent_pi_sessions.some(session=>session.thread_id===thread.id))throw new Error('Conflicting migration; originals untouched');
            const run=runs.at(-1);
            if(!Array.isArray(run.context)||!run.model_config?.model||!run.model_config?.limits)throw new Error('Invalid legacy run');
            const manager=SessionManager.inMemory(process.cwd());
            const offsets=new Map(),owners=new Map();
            for(const message of deduplicateToolResults(run.context)){
                const ownerRun=runs.find(candidate=>candidate.context.some(part=>JSON.stringify(part)===JSON.stringify(message)))||run;
                let first;
                for(const native of await convertLegacyMessage(message,ownerRun)){
                    const id=manager.appendMessage(native);first??=id;owners.set(id,ownerRun.id);
                }offsets.set(message,first);
            }
            const pending=tables.agent_steps.filter(step=>step.run_id===run.id&&step.status==='decided'&&step.kind==='decision').sort((a,b)=>a.step-b.step).at(-1);
            if(pending){
                const assistant=pending.decision.messages?.filter(message=>message.role==='assistant')||[];
                for(const message of assistant)for(const native of await convertLegacyMessage(message,run))manager.appendMessage(native);
                for(const call of pending.decision.calls||[]){
                    const receipt=tables.agent_tool_receipts.find(receipt=>receipt.run_id===run.id&&receipt.call_id===call.toolCallId);
                    const result=receipt?.result||{operationId:call.toolCallId,status:run.status,wait:run.wait};
                    manager.appendMessage({role:'toolResult',toolCallId:call.toolCallId,toolName:call.toolName,content:[{type:'text',text:JSON.stringify(result)}],details:result,isError:Boolean(result.error),timestamp:0});
                    if(!receipt)await client.query('INSERT INTO agent_pi_pending(run_id,call_id,name,input) VALUES($1,$2,$3,$4)',[run.id,call.toolCallId,call.toolName,JSON.stringify(call.input)]);
                }
                await client.query("UPDATE agent_steps SET decision=jsonb_set(decision,'{calls}',$3) WHERE run_id=$1 AND step=$2",[run.id,pending.step,JSON.stringify((pending.decision.calls||[]).map(call=>({...call,nativeId:call.toolCallId})))]);
            }
            const checkpoint=run.context_checkpoint;
            if(checkpoint?.offset){
                const kept=offsets.get(run.context[checkpoint.offset]);
                if(checkpoint.version!==1||!checkpoint.summary||!kept)throw new Error('Invalid legacy checkpoint');
                manager.appendCompaction(checkpoint.summary,kept,0,{migration:true});
            }
            const entries=[manager.getHeader(),...manager.getEntries()];validatePiSnapshot({version:1,signature,entries});
            await client.query('INSERT INTO agent_pi_sessions(thread_id,storage_version,signature,system_prompt) VALUES($1,1,$2,$3)',[thread.id,signature,[run.model_config.coreRules||coreRules,nodeRules].join('\n\n')]);
            for(const [position,entry] of entries.entries())await client.query('INSERT INTO agent_pi_entries(thread_id,position,entry_id,turn_id,body) VALUES($1,$2,$3,$4,$5)',[thread.id,position,entry.id,owners.get(entry.id)||run.id,JSON.stringify(entry)]);
            for(const old of runs){
                const unknown=tables.agent_steps.some(step=>step.run_id===old.id&&step.status==='requesting');
                const interrupted=['queued','running'].includes(old.status);
                await client.query("UPDATE agent_runs SET storage_version=2,execution_token=NULL,status=$2,wait=$3 WHERE id=$1",[old.id,unknown?'unknown':interrupted?'waiting_input':old.status,JSON.stringify(unknown?{type:'unknown_model',question:'迁移前请求结果未知，不自动重发。'}:interrupted?{type:'authorization',code:'AGENT_MIGRATED',recovery:'service',question:'会话已迁移，明确继续后重新检查身份与当前画布。'}:old.wait)]);
                if(unknown)await client.query("UPDATE agent_steps SET status='unknown' WHERE run_id=$1 AND status='requesting'",[old.id]);
                migrated++;
            }
        }
        await client.query('COMMIT');return {backup,checksum,migrated};
    }catch(error){await client.query('ROLLBACK');throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
    const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
    try{console.log(JSON.stringify(await migrateAgentPi(client,resolve('data/agent-backups'))));}finally{await client.end();}
}
