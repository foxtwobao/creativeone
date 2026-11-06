import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createCreativeSession, validatePiSnapshot, type PiSnapshot } from "./agent/pi-session.js";

async function fixture(responses:any[],options:{saved?:PiSnapshot;fail?:()=>boolean;execute?:(id:string,args:any)=>Promise<any>}={}){
    const faux=fauxProvider();faux.setResponses(responses);
    const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
    let saved=options.saved;const requests:any[]=[],writes:string[]=[];
    const host=await createCreativeSession({cwd:process.cwd(),signature:"fixture-1",system:"创作助手：先读取，后修改。",runtime,model:faux.getModel(),
        persistence:{load:async()=>structuredClone(saved),append:async(snapshot,expected)=>{
            if(options.fail?.())throw new Error("COMMIT_FAILED");
            assert.equal(expected,saved?.entries.length||0);assert.deepEqual(snapshot.entries.slice(0,expected),saved?.entries||[]);saved=structuredClone(snapshot);
        }},
        stream:(model,context,options)=>{requests.push(structuredClone(context));return runtime.streamSimple(model,context,options);},
        tools:[{name:"write_node",label:"写节点",description:"测试工具",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},execute:async(id,args)=>{
            assert.ok(saved?.entries.some(entry=>entry.type==="message"&&entry.message.role==="assistant"));writes.push(id);
            return options.execute?options.execute(id,args):{content:[{type:"text",text:"已保存"}]};
        }}],
        validateDecision:message=>message.role==="assistant"&&message.content.some(part=>part.type==="toolCall"&&(typeof part.arguments.text!=="string"||Object.keys(part.arguments).some(key=>key!=="text")))?"text 必须为字符串":undefined,
    });
    return {host,requests,writes,snapshot:()=>structuredClone(saved!)};
}
const decision=(...calls:any[])=>fauxAssistantMessage(calls,{stopReason:"toolUse"});
const call=(id:string,text:unknown)=>fauxToolCall("write_node",{text},{id});

test("Pi host persists native messages before effects and restores an unchanged prefix",async()=>{
    const first=await fixture([decision(call("one","节点")),fauxAssistantMessage("完成")]);
    try{
        await first.host.prompt("创建");assert.deepEqual(first.writes,["one"]);
        const saved=first.snapshot(),second=await fixture([fauxAssistantMessage("继续")],{saved});
        try{await second.host.prompt("继续");assert.deepEqual(second.snapshot().entries.slice(0,saved.entries.length),saved.entries);assert.deepEqual(second.requests[0].messages.slice(0,first.requests[1].messages.length),first.requests[1].messages);}
        finally{second.host.dispose();}
    }finally{first.host.dispose();}
});
test("Pi host rejects the complete invalid decision and feeds one result for each call",async()=>{
    const ctx=await fixture([decision(call("sibling","有效"),call("bad",1)),decision(call("fixed","修正")),fauxAssistantMessage("完成")]);
    try{await ctx.host.prompt("写入");assert.deepEqual(ctx.writes,["fixed"]);for(const id of ["sibling","bad"])assert.equal(ctx.requests[1].messages.filter((message:any)=>message.role==="toolResult"&&message.toolCallId===id).length,1);}
    finally{ctx.host.dispose();}
});
test("Pi host poisons the session after a persistence failure",async()=>{
    let failed=false;
    const ctx=await fixture([decision(call("one","节点"))],{fail:()=>failed});
    try{
        failed=true;await assert.rejects(()=>ctx.host.prompt("创建"),/COMMIT_FAILED/);
        assert.equal(ctx.writes.length,0);assert.equal(ctx.requests.length,0);
        failed=false;await assert.rejects(()=>ctx.host.prompt("不能重用"),/COMMIT_FAILED/);
    }finally{ctx.host.dispose();}
});
test("Pi host waits for a persisted business operation without overwriting its receipt",async()=>{
    const first=await fixture([decision(call("pending","等待确认"),call("later","不得执行"))],{execute:async()=>({content:[{type:"text",text:"请求已登记"}],terminate:true})});
    try{
        await first.host.prompt("生成");assert.deepEqual(first.writes,["pending"]);assert.equal(first.requests.length,1);
        const saved=first.snapshot(),next=await fixture([fauxAssistantMessage("已受理")],{saved});
        try{await next.host.notify("原请求已获确认并受理",{operationId:"pending"});assert.deepEqual(next.snapshot().entries.slice(0,saved.entries.length),saved.entries);assert.equal(next.writes.length,0);}
        finally{next.host.dispose();}
    }finally{first.host.dispose();}
});
test("Pi host saves a truncated response and stops without executing tools",async()=>{
    const ctx=await fixture([fauxAssistantMessage([call("partial","未完成")],{stopReason:"length"})]);
    try{await assert.rejects(()=>ctx.host.prompt("创建"),/AGENT_MODEL_OUTPUT_LIMIT/);assert.equal(ctx.writes.length,0);assert.equal(ctx.requests.length,1);assert.ok(ctx.snapshot().entries.some(entry=>entry.type==="message"&&entry.message.role==="assistant"&&entry.message.stopReason==="length"));}
    finally{ctx.host.dispose();}
});
test("Pi host refuses unknown versions, broken ancestry and changed configuration",async()=>{
    const ctx=await fixture([fauxAssistantMessage("完成")]);await ctx.host.prompt("讨论");const saved=ctx.snapshot();ctx.host.dispose();
    assert.throws(()=>validatePiSnapshot({...saved,version:9 as 1}),/AGENT_STORAGE_VERSION/);
    const corrupt=structuredClone(saved);(corrupt.entries[1] as any).parentId="missing";assert.throws(()=>validatePiSnapshot(corrupt),/AGENT_CONTEXT_CHECKPOINT_INVALID/);
    await assert.rejects(()=>fixture([],{saved:{...saved,signature:"other"}}),/AGENT_SESSION_CONFIG_CHANGED/);
});
test("Pi applies an appended context repair while preserving original entry bytes",async()=>{
    const first=await fixture([fauxAssistantMessage("保留的原回复")]);await first.host.prompt("原输入");const saved=first.snapshot();first.host.dispose();
    const manager=SessionManager.inMemory(process.cwd(),undefined,structuredClone(saved.entries));
    const duplicate=manager.appendMessage(fauxAssistantMessage("应排除的重复回复"));manager.appendContextEdit(duplicate,null);
    const repaired={...saved,entries:[manager.getHeader()!,...manager.getEntries()]};validatePiSnapshot(repaired);
    const next=await fixture([fauxAssistantMessage("继续完成")],{saved:repaired});
    try{
        await next.host.prompt("继续");assert.deepEqual(next.snapshot().entries.slice(0,repaired.entries.length),repaired.entries);
        assert.equal(JSON.stringify(next.requests[0].messages).includes("应排除的重复回复"),false);
        assert.ok(JSON.stringify(next.requests[0].messages).includes("保留的原回复"));
        assert.deepEqual(repaired.entries.slice(0,saved.entries.length),saved.entries);
    }finally{next.host.dispose();}
});
