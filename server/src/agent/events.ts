import { EventEmitter } from "node:events";
import { db } from "../db.js";
import type { PoolClient } from "pg";

// Events are hints; PostgreSQL snapshots remain authoritative.
export const agentEvents=new EventEmitter().setMaxListeners(0);
type Listener={client:PoolClient;closing:boolean;failed:boolean;stops:Map<symbol,()=>void>;cleanup:()=>void};
let channel:Promise<Listener>|undefined;
function openChannel() {
    const pending=(async()=>{
        const client=await db.connect(),state:Listener={client,closing:false,failed:false,stops:new Map(),cleanup:()=>{}};
        const notification=(event:any)=>{
            if(event.channel!=="creativeone_agent_items")return;
            let ids:any;try{ids=JSON.parse(event.payload || "");}catch{return;}
            void db.query('SELECT thread_id AS "threadId",turn_id AS "turnId",item_id AS "itemId",role,text,detail FROM agent_items WHERE thread_id=$1 AND turn_id=$2 AND item_id=$3',[ids.threadId,ids.turnId,ids.itemId]).then(result=>{const item=result.rows[0];if(item?.detail?.streaming)agentEvents.emit(item.threadId,item);}).catch(()=>undefined);
        };
        const failed=()=>{state.failed=true;for(const stop of state.stops.values())stop();};
        client.on("notification",notification);client.once("error",failed);
        state.cleanup=()=>{client.off("notification",notification);client.off("error",failed);};
        try{await client.query("LISTEN creativeone_agent_items");return state;}catch(error){state.cleanup();client.release(true);throw error;}
    })();
    channel=pending;void pending.catch(()=>{if(channel===pending)channel=undefined;});return pending;
}
// One existing pool connection is leased only while SSE subscribers exist; execution slots stay unchanged.
export async function subscribeAgentThread(id:string,listener:(item:any)=>void,onDisconnect:()=>void=()=>{}):Promise<()=>Promise<void>> {
    const pending=channel || openChannel(),state=await pending;
    if(state.closing)return subscribeAgentThread(id,listener,onDisconnect);
    if(state.failed){state.closing=true;if(channel===pending)channel=undefined;state.cleanup();state.client.release(true);throw new Error("AGENT_STREAM_UNAVAILABLE");}
    const key=Symbol();state.stops.set(key,onDisconnect);agentEvents.on(id,listener);
    return async()=>{
        if(!state.stops.delete(key))return;
        agentEvents.off(id,listener);
        if(state.stops.size)return;
        state.closing=true;if(channel===pending)channel=undefined;
        await state.client.query("UNLISTEN creativeone_agent_items").catch(()=>{state.failed=true;}).finally(()=>{state.cleanup();state.client.release(state.failed);});
    };
}
