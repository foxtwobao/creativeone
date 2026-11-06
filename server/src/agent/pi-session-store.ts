import type { PoolClient } from "pg";
import { HttpError } from "../http.js";
import { validatePiSnapshot, type PiSnapshot, type PiSessionPersistence } from "./pi-session.js";

type Client=Pick<PoolClient,"query">;
export function piSessionStore(userId:string,threadId:string,turnId:string,executionToken:string,query:Client["query"],transaction:<T>(work:(client:Client)=>Promise<T>)=>Promise<T>,options:{system?:string;onAppend?:(client:Client,entries:PiSnapshot["entries"])=>Promise<void>}={}):PiSessionPersistence {
    return {
        async load(){
            const rows=(await query("SELECT s.storage_version,s.signature,e.body,e.position,e.entry_id,r.thread_id AS entry_thread,r.user_id AS entry_owner FROM agent_pi_sessions s JOIN agent_threads t ON t.id=s.thread_id LEFT JOIN agent_pi_entries e ON e.thread_id=s.thread_id LEFT JOIN agent_runs r ON r.id=e.turn_id WHERE t.id=$1 AND t.user_id=$2 ORDER BY e.position",[threadId,userId])).rows;
            if(!rows.length)return undefined;
            let entries:PiSnapshot["entries"];try{entries=rows.map(row=>JSON.parse(row.body));}catch{throw new HttpError(409,"AGENT_CONTEXT_CHECKPOINT_INVALID");}
            if(rows.some((row,index)=>!row.body||row.position!==index||row.entry_thread!==threadId||row.entry_owner!==userId||entries[index]?.id!==row.entry_id))throw new HttpError(409,"AGENT_CONTEXT_CHECKPOINT_INVALID");
            const snapshot:PiSnapshot={version:rows[0].storage_version,signature:rows[0].signature,entries};
            validatePiSnapshot(snapshot);return snapshot;
        },
        async append(snapshot,expectedLength){
            validatePiSnapshot(snapshot);
            await transaction(async client=>{
                const thread=(await client.query("SELECT t.id FROM agent_threads t JOIN agent_runs r ON r.thread_id=t.id WHERE t.id=$1 AND t.user_id=$2 AND r.id=$3 AND r.user_id=$2 AND r.execution_token=$4 AND r.status IN ('running','waiting_input','waiting_confirmation','waiting_tasks') AND t.active_run_id=r.id FOR UPDATE OF t,r",[threadId,userId,turnId,executionToken])).rows[0];
                if(!thread)throw new HttpError(409,"AGENT_EXECUTION_CHANGED");
                const stored=(await client.query("SELECT storage_version,signature FROM agent_pi_sessions WHERE thread_id=$1",[threadId])).rows[0];
                if(stored&&(stored.storage_version!==snapshot.version||stored.signature!==snapshot.signature))throw new HttpError(409,"AGENT_STORAGE_VERSION");
                const count=Number((await client.query("SELECT count(*) AS count FROM agent_pi_entries WHERE thread_id=$1",[threadId])).rows[0].count);
                if(count!==expectedLength)throw new HttpError(409,"AGENT_EXECUTION_CHANGED");
                if(!stored)await client.query("INSERT INTO agent_pi_sessions(thread_id,storage_version,signature,system_prompt) VALUES($1,$2,$3,$4)",[threadId,snapshot.version,snapshot.signature,options.system||""]);
                for(let position=expectedLength;position<snapshot.entries.length;position++){
                    const entry=snapshot.entries[position];
                    await client.query("INSERT INTO agent_pi_entries(thread_id,position,entry_id,turn_id,body) VALUES($1,$2,$3,$4,$5)",[threadId,position,entry.id,turnId,JSON.stringify(entry)]);
                }
                await options.onAppend?.(client,snapshot.entries.slice(expectedLength));
            });
        },
    };
}
