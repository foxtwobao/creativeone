// Dependency-contract probes only. No production services, upstream requests or Pi patches.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { z } from 'zod';

const root=process.env.PI_EVAL_MODULE_ROOT;
if(!root)throw new Error('Set PI_EVAL_MODULE_ROOT to an isolated node_modules directory');
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Network disabled in Pi session evaluation');};
const cwd=process.env.PI_SESSION_TEST_CWD || await mkdtemp(join(tmpdir(),'creativeone-pi-session-'));
after(async()=>{globalThis.fetch=originalFetch;if(!process.env.PI_SESSION_TEST_CWD)await rm(cwd,{recursive:true,force:true});});
for(const name of ['pi-coding-agent','pi-agent-core','pi-ai']){
    const pkg=JSON.parse(await readFile(join(root,'@earendil-works',name,'package.json'),'utf8'));
    assert.equal(pkg.version,'1.5.0');
}
const sdk=await import(pathToFileURL(join(root,'@earendil-works/pi-coding-agent/dist/index.js')));
const ai=await import(pathToFileURL(join(root,'@earendil-works/pi-ai/dist/index.js')));
const {createAgentSession,SessionManager,SettingsManager,ModelRuntime,createExtensionRuntime}=sdk;
const {fauxProvider,fauxAssistantMessage,fauxToolCall,InMemoryCredentialStore,InMemoryModelsStore}=ai;
const call=(name,args,id)=>fauxToolCall(name,args,{id});
const decision=(...calls)=>fauxAssistantMessage(calls,{stopReason:'toolUse'});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const entries=session=>structuredClone([session.sessionManager.getHeader(),...session.sessionManager.getEntries()]);
const results=messages=>messages.filter(message=>message.role==='toolResult');
const resources=()=>({
    getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),
    getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),
    getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),
    getSystemPrompt:()=> '你是创作助手。先读取再修改；生成必须由业务服务验证授权。',
    getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],
    extendResources:()=>{},reload:async()=>{},
});
async function fixture(responses,{saved,execute,onMessage,onRequest,settings={},extraTools=[]}={}){
    const faux=fauxProvider(),requests=[],writes=[];
    faux.setResponses(responses);
    const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,refreshOnCreate:false});
    runtime.registerNativeProvider(faux.provider);
    const customTools=[{
        name:'canvas_write',label:'写入画布',description:'写入测试节点',
        parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
        constrainedSampling:{type:'json_schema',strict:'require'},
        execute:async(id,args)=>{writes.push({id,args});return execute?execute(id,args):{content:[{type:'text',text:'已保存'}],details:{id}};},
    },...extraTools];
    const {session}=await createAgentSession({cwd,model:faux.getModel(),modelRuntime:runtime,thinkingLevel:'off',
        resourceLoader:resources(),tools:customTools.map(tool=>tool.name),customTools,
        settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,provider:{maxRetries:0}},cacheWarming:'off',...settings}),
        sessionManager:SessionManager.inMemory(cwd,undefined,saved),
    });
    session.agent.toolExecution='sequential';
    const stream=session.agent.streamFunction;
    session.agent.streamFunction=async(model,context,options)=>{requests.push(structuredClone(context));await onRequest?.(context,session);return stream(model,context,options);};
    if(onMessage)session.agent.subscribe(async event=>{if(event.type==='message_end')await onMessage(event,session);});
    return {session,requests,writes};
}

// A deliberately small host adapter over public SDK APIs. Only the isolated probe database is used.
async function connectProbe(){
    const url=new URL(process.env.TEST_DATABASE_URL);
    assert.match(url.pathname,/^\/creativeone_pi_sdk_[a-f0-9]{32}_test$/);
    const db=new pg.Client({connectionString:url.href});await db.connect();return db;
}
async function saveEntries(db,id,session){
    const current=entries(session),old=(await db.query('SELECT body FROM transcript WHERE session=$1 ORDER BY position',[id])).rows;
    assert.ok(current.length>=old.length,'Never remove history');
    for(let index=0;index<old.length;index++)assert.equal(JSON.stringify(current[index]),old[index].body,'Never rewrite a finalized entry');
    for(let index=old.length;index<current.length;index++)await db.query('INSERT INTO transcript VALUES($1,$2,$3)',[id,index,JSON.stringify(current[index])]);
}
async function savedEntries(db,id){return (await db.query('SELECT body FROM transcript WHERE session=$1 ORDER BY position',[id])).rows.map(row=>JSON.parse(row.body));}
async function effect(db,id,callId,args,requireApproval=false){
    await db.query('BEGIN');
    try{
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
        const old=(await db.query('SELECT input,result FROM receipts WHERE session=$1 AND call_id=$2',[id,callId])).rows[0];
        if(old){assert.deepEqual(JSON.parse(old.input),args);await db.query('COMMIT');return JSON.parse(old.result);}
        if(requireApproval)assert.equal((await db.query('SELECT approved FROM operations WHERE session=$1',[id])).rows[0]?.approved,true,'Exact operation is not approved');
        const result={content:[{type:'text',text:'真实测试业务回执：已保存'}],details:{id:callId}};
        await db.query('INSERT INTO effects VALUES($1,$2)',[id,callId]);
        await db.query('INSERT INTO receipts VALUES($1,$2,$3,$4)',[id,callId,JSON.stringify(args),JSON.stringify(result)]);
        await db.query('COMMIT');return result;
    }catch(error){await db.query('ROLLBACK');throw error;}
}
async function childMain(){
    const [mode,id]=process.argv.slice(3),db=await connectProbe();let ctx;
    const crash=()=>process.kill(process.pid,'SIGKILL');
    try{
        if(mode==='approve'){
            await assert.rejects(()=>effect(db,id,'generate-1',{text:'固定已确认内容'},true),/not approved/);
            await db.query('UPDATE operations SET approved=true WHERE session=$1',[id]);
            await effect(db,id,'generate-1',{text:'固定已确认内容'},true);
            await effect(db,id,'generate-1',{text:'固定已确认内容'},true);
            return;
        }
        if((await db.query("SELECT 1 FROM requests WHERE session=$1 AND state='requesting'",[id])).rowCount){
            assert.equal(mode,'recover-unknown');return;
        }
        const saved=await savedEntries(db,id);
        const recover=mode==='recover'||mode==='resume';
        ctx=await fixture(recover?[fauxAssistantMessage('按真实结果继续')]:[decision(call('canvas_write',{text:'固定已确认内容'},'write-1')),fauxAssistantMessage('完成')],{
            saved:saved.length?saved:undefined,
            onRequest:async(context,session)=>{
                await db.query('BEGIN');
                try{await saveEntries(db,id,session);await db.query("INSERT INTO requests(session,state,body) VALUES($1,'requesting',$2)",[id,JSON.stringify(context.messages)]);await db.query('COMMIT');}
                catch(error){await db.query('ROLLBACK');throw error;}
                if(mode==='request-crash')crash();
            },
            onMessage:async(event,session)=>{
                await db.query('BEGIN');
                try{
                    await saveEntries(db,id,session);
                    if(event.message.role==='assistant')await db.query("UPDATE requests SET state='responded' WHERE session=$1 AND state='requesting'",[id]);
                    await db.query('COMMIT');
                }catch(error){await db.query('ROLLBACK');throw error;}
                if(mode==='decision-crash'&&event.message.role==='assistant'&&event.message.stopReason==='toolUse')crash();
            },
            execute:async(callId,args)=>{
                if(mode==='prepare'){
                    await db.query('INSERT INTO operations VALUES($1,false)',[id]);
                    return {content:[{type:'text',text:'具体请求已登记，尚未生成'}],details:{operationId:id,status:'awaiting_confirmation'},terminate:true};
                }
                const result=await effect(db,id,callId,args);if(mode==='receipt-crash')crash();return result;
            },
        });
        if(recover){
            // Repair only an unfinished tail from its original decision and durable business receipt.
            const messages=ctx.session.messages;
            for(const message of messages.filter(message=>message.role==='assistant'))for(const part of message.content){
                if(part.type!=='toolCall'||results(messages).some(result=>result.toolCallId===part.id))continue;
                const result=await effect(db,id,part.id,part.arguments);
                ctx.session.sessionManager.appendMessage({role:'toolResult',toolCallId:part.id,toolName:part.name,content:result.content,details:result.details,isError:false,timestamp:Date.now()});
            }
            await saveEntries(db,id,ctx.session);
            await ctx.session.sendCustomMessage({customType:'creativeone.operation_result',content:mode==='resume'?'业务请求已获具体确认并完成，已有真实回执。':'已恢复原调用的真实回执，请继续未完成部分。',display:true},{triggerTurn:true});
        }else await ctx.session.prompt('执行测试请求',{expandPromptTemplates:false});
        await saveEntries(db,id,ctx.session);
    }finally{ctx?.session.dispose();await db.end();}
}
if(process.argv[2]==='--child'){
    await childMain();
}else{
test('SDK runs only host tools and preserves the previous request prefix across user turns',async()=>{
    const ctx=await fixture([decision(call('canvas_write',{text:'第一版'},'write-1')),fauxAssistantMessage('已完成'),fauxAssistantMessage('继续')]);
    try{
        assert.deepEqual(ctx.session.getActiveToolNames(),['canvas_write']);
        await ctx.session.prompt('创建节点',{expandPromptTemplates:false});
        const original=structuredClone(ctx.session.messages);
        await ctx.session.prompt('继续讨论',{expandPromptTemplates:false});
        assert.deepEqual(ctx.requests[1].messages.slice(0,ctx.requests[0].messages.length),ctx.requests[0].messages);
        assert.deepEqual(ctx.requests[2].messages.slice(0,original.length),original);
        assert.equal(ctx.writes.length,1);
        assert.equal(results(ctx.requests[1].messages).filter(message=>message.toolCallId==='write-1').length,1);
    }finally{ctx.session.dispose();}
});

test('session.subscribe does not await async listeners; it is not a database commit barrier',async()=>{
    const gate=deferred(),entered=deferred();let saved=false;
    const ctx=await fixture([decision(call('canvas_write',{text:'test'},'write-1')),fauxAssistantMessage('完成')]);
    ctx.session.subscribe(async event=>{if(event.type==='message_end'&&event.message.role==='assistant'){entered.resolve();await gate.promise;saved=true;}});
    try{const work=ctx.session.prompt('执行');await entered.promise;await work;assert.equal(saved,false);assert.equal(ctx.writes.length,1);}
    finally{gate.resolve();ctx.session.dispose();}
});

test('public agent subscription waits after SDK appends the decision and before tools',async()=>{
    const gate=deferred(),entered=deferred();
    const ctx=await fixture([decision(call('canvas_write',{text:'test'},'write-1')),fauxAssistantMessage('完成')],{onMessage:async(event,session)=>{
        if(event.message.role==='assistant'&&event.message.stopReason==='toolUse'){
            assert.ok(entries(session).some(entry=>entry.type==='message'&&entry.message.content.some?.(part=>part.id==='write-1')));
            entered.resolve();await gate.promise;
        }
    }});
    try{const work=ctx.session.prompt('执行');await entered.promise;assert.equal(ctx.writes.length,0);gate.resolve();await work;assert.equal(ctx.writes.length,1);}
    finally{gate.resolve();ctx.session.dispose();}
});

test('failed decision persistence prevents execution and follow-up requests',async()=>{
    const ctx=await fixture([decision(call('canvas_write',{text:'test'},'write-1'))],{onMessage:async event=>{
        if(event.message.role==='assistant'&&event.message.stopReason==='toolUse')throw new Error('database commit failed');
    }});
    try{await ctx.session.prompt('执行');assert.equal(ctx.writes.length,0);assert.equal(ctx.requests.length,1);}
    finally{ctx.session.dispose();}
});

test('native entries restore a session without rewriting finalized messages',async()=>{
    const first=await fixture([decision(call('canvas_write',{text:'test'},'write-1')),fauxAssistantMessage('完成')]);
    await first.session.prompt('执行');const saved=entries(first.session),history=structuredClone(first.session.messages);first.session.dispose();
    const next=await fixture([fauxAssistantMessage('继续')],{saved});
    try{
        assert.deepEqual(next.session.messages,history);
        await next.session.prompt('继续',{expandPromptTemplates:false});
        assert.deepEqual(next.requests[0].messages.slice(0,history.length),history);
        assert.deepEqual(entries(next.session).slice(0,saved.length),saved);
        assert.equal(next.writes.length,0);
    }finally{next.session.dispose();}
});

test('a real pending-operation receipt ends the turn; completion is appended after restore',async()=>{
    const first=await fixture([decision(call('canvas_write',{text:'等待具体确认'},'request-1'))],{execute:async()=>({content:[{type:'text',text:'请求已登记，等待确认；尚未生成'}],details:{operationId:'op-1',status:'awaiting_confirmation'},terminate:true})});
    await first.session.prompt('生成');assert.equal(first.requests.length,1);
    const saved=entries(first.session),history=structuredClone(first.session.messages);first.session.dispose();
    const next=await fixture([fauxAssistantMessage('已完成')],{saved});
    try{
        await next.session.sendCustomMessage({customType:'creativeone.operation_result',content:'业务服务回执：op-1 已获确认并受理，taskId=task-1。',display:true},{triggerTurn:true});
        assert.deepEqual(next.requests[0].messages.slice(0,history.length),history);
        assert.equal(results(next.requests[0].messages).filter(message=>message.toolCallId==='request-1').length,1);
        assert.equal(next.writes.length,0);
        assert.deepEqual(entries(next.session).slice(0,saved.length),saved);
    }finally{next.session.dispose();}
});

test('skill text is appended as a tool result without changing the system prefix',async()=>{
    const skillText='先读取原剧本，再按用户目标拆分镜头；不得自动生成。';
    const ctx=await fixture([decision(call('load_skill',{name:'storyboard'},'skill-1')),fauxAssistantMessage('按规则处理')],{extraTools:[{
        name:'load_skill',label:'读取规则',description:'读取服务端规则快照',
        parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false},
        execute:async()=>({content:[{type:'text',text:skillText}],details:{name:'storyboard',version:1}}),
    }]});
    try{
        await ctx.session.prompt('拆分镜');
        assert.deepEqual(ctx.requests[1].messages.slice(0,ctx.requests[0].messages.length),ctx.requests[0].messages);
        assert.equal(results(ctx.requests[1].messages)[0].content[0].text,skillText);
        assert.ok(!JSON.stringify(ctx.requests[0].messages[0]).includes(skillText));
    }finally{ctx.session.dispose();}
});

test('manual SDK compaction appends a checkpoint and keeps all original entries across restore',async()=>{
    const ctx=await fixture([decision(call('canvas_write',{text:'旧节点'},'old-write')),fauxAssistantMessage('旧讨论'),fauxAssistantMessage('最近讨论'),fauxAssistantMessage('摘要：保留用户目标'),fauxAssistantMessage('继续')],{
        settings:{compaction:{enabled:false,keepRecentTokens:1,reserveTokens:100}},
    });
    try{
        await ctx.session.prompt('第一轮用户目标'.repeat(100));await ctx.session.prompt('第二轮用户要求');
        const before=entries(ctx.session);
        await ctx.session.compact('用中文保留用户目标和真实结果');
        const compacted=entries(ctx.session);
        assert.deepEqual(compacted.slice(0,before.length),before);
        assert.ok(compacted.some(entry=>entry.type==='compaction'));
        const projected=ctx.session.messages;
        const calls=projected.filter(message=>message.role==='assistant').flatMap(message=>message.content.filter(part=>part.type==='toolCall'));
        for(const result of results(projected))assert.ok(calls.some(call=>call.id===result.toolCallId),'No orphan tool result after compaction');
        for(const call of calls)assert.equal(results(projected).filter(result=>result.toolCallId===call.id).length,1,'No split call/result pair after compaction');
        const restored=await fixture([fauxAssistantMessage('继续')],{saved:compacted});
        try{assert.deepEqual(restored.session.messages,ctx.session.messages);}
        finally{restored.session.dispose();}
    }finally{ctx.session.dispose();}
});

test('disabled SDK retry and compaction plus an end hook stop truncated responses',async()=>{
    const ctx=await fixture([fauxAssistantMessage([call('canvas_write',{text:'未完成'},'partial')],{stopReason:'length'})]);
    ctx.session.agent.finishTurn=async()=>({action:'end'});
    try{await ctx.session.prompt('执行');assert.equal(ctx.requests.length,1);assert.equal(ctx.writes.length,0);}
    finally{ctx.session.dispose();}
});

test('actual Responses payload preserves tools and the prior input prefix across turns',async()=>{
    const ctx=await fixture([decision(call('canvas_write',{text:'节点'},'write-1')),fauxAssistantMessage('完成'),fauxAssistantMessage('继续')]);
    const {stream}=await import(pathToFileURL(join(root,'@earendil-works/pi-ai/dist/api/openai-responses.js')));
    const model={id:'fixture',name:'fixture',api:'openai-responses',provider:'fixture',baseUrl:'https://fixture.invalid/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8192,compat:{supportsStrictMode:true}};
    try{
        await ctx.session.prompt('执行');await ctx.session.prompt('继续');
        const payloads=[];
        for(const request of ctx.requests){
            await stream(model,ai.normalizeContext(request),{apiKey:'fixture',maxRetries:0,onPayload:payload=>{payloads.push(payload);throw new Error('Captured without network');}}).result();
        }
        for(let index=1;index<payloads.length;index++){
            assert.deepEqual(payloads[index].tools,payloads[0].tools);
            assert.deepEqual(payloads[index].input.slice(0,payloads[index-1].input.length),payloads[index-1].input);
        }
        assert.equal(Object.hasOwn(payloads[0],'max_output_tokens'),false);
        assert.equal(payloads[0].tools[0].strict,true);
    }finally{ctx.session.dispose();}
});

test('SDK raw whole-decision validation prevents sibling effects and keeps one result per call',async()=>{
    const rawSchema=z.object({text:z.string()}).strict();let invalid=false;
    const ctx=await fixture([
        decision(call('canvas_write',{text:'valid sibling'},'sibling'),call('canvas_write',{text:1},'invalid')),
        decision(call('canvas_write',{text:'corrected'},'corrected')),fauxAssistantMessage('完成'),
    ],{onMessage:async event=>{
        if(event.message.role==='assistant')invalid=event.message.content.some(part=>part.type==='toolCall'&&!rawSchema.safeParse(part.arguments).success);
    }});
    const before=ctx.session.agent.beforeToolCall;
    ctx.session.agent.beforeToolCall=async(context,signal)=>invalid?{block:true,reason:'原始参数无效，整次决定未执行，请修正 text 为字符串'}:before?.(context,signal);
    try{
        await ctx.session.prompt('执行');assert.deepEqual(ctx.writes.map(write=>write.id),['corrected']);
        for(const id of ['sibling','invalid'])assert.equal(results(ctx.requests[1].messages).filter(message=>message.toolCallId===id).length,1);
        assert.ok(!entries(ctx.session).some(entry=>entry.type==='context_edit'));
    }finally{ctx.session.dispose();}
});

test('mixed pending and successful results require an explicit finishTurn gate',async()=>{
    let pending=false;
    const ctx=await fixture([decision(call('canvas_write',{text:'等待确认'},'pending'),call('canvas_write',{text:'读取完成'},'read'))],{
        execute:async(id)=>{
            if(id==='pending'){pending=true;return {content:[{type:'text',text:'请求已登记，等待确认'}],terminate:true};}
            return {content:[{type:'text',text:'已有信息'}]};
        },
    });
    const finish=ctx.session.agent.finishTurn;
    ctx.session.agent.finishTurn=async(turn,signal)=>pending?{action:'end'}:finish?.(turn,signal);
    try{await ctx.session.prompt('执行');assert.equal(ctx.requests.length,1);assert.equal(results(ctx.session.messages).length,2);}
    finally{ctx.session.dispose();}
});

test('isolated PostgreSQL: confirmation, native entry recovery, crash boundaries and unique effects', {skip:process.env.PI_EVAL_POSTGRES!=='1'},async()=>{
    const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
    const name=`creativeone_pi_sdk_${randomUUID().replaceAll('-','')}_test`,url=new URL(process.env.DATABASE_URL);url.pathname=`/${name}`;
    let db,created=false;
    const child=async(mode,id,crashed=false)=>{
        const exit=await new Promise((resolve,reject)=>{
            const processChild=spawn(process.execPath,[new URL(import.meta.url).pathname,'--child',mode,id],{
                stdio:['ignore','pipe','pipe'],env:{...process.env,TEST_DATABASE_URL:url.href,PI_SESSION_TEST_CWD:cwd},
            });
            let output='';processChild.stdout.on('data',chunk=>{output+=chunk;});processChild.stderr.on('data',chunk=>{output+=chunk;});
            processChild.on('error',reject);processChild.on('exit',(code,signal)=>resolve({code,signal,output}));
        });
        if(crashed)assert.equal(exit.signal,'SIGKILL',exit.output);else assert.equal(exit.code,0,exit.output);
    };
    try{
        await admin.query(`CREATE DATABASE "${name}"`);created=true;
        db=new pg.Client({connectionString:url.href});await db.connect();
        await db.query(`CREATE TABLE transcript(session text,position integer,body text,PRIMARY KEY(session,position));
            CREATE TABLE requests(id serial PRIMARY KEY,session text,state text,body text);
            CREATE TABLE effects(session text,call_id text,PRIMARY KEY(session,call_id));
            CREATE TABLE receipts(session text,call_id text,input text,result text,PRIMARY KEY(session,call_id));
            CREATE TABLE operations(session text PRIMARY KEY,approved boolean);`);
        await child('prepare','approval');
        const before=await savedEntries(db,'approval');assert.equal((await db.query('SELECT * FROM effects')).rowCount,0);
        await child('approve','approval');await child('resume','approval');
        assert.equal((await db.query("SELECT * FROM effects WHERE session='approval'")).rowCount,1);
        const afterApproval=await savedEntries(db,'approval');assert.deepEqual(afterApproval.slice(0,before.length),before);
        for(const mode of ['decision-crash','receipt-crash']){
            await child(mode,mode,true);
            const beforeCrash=await savedEntries(db,mode);
            await child('recover',mode);await child('recover',mode);
            assert.equal((await db.query('SELECT * FROM effects WHERE session=$1',[mode])).rowCount,1);
            const restored=await savedEntries(db,mode);assert.deepEqual(restored.slice(0,beforeCrash.length),beforeCrash);
            assert.equal(restored.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolCallId==='write-1').length,1);
        }
        await child('request-crash','unknown',true);await child('recover-unknown','unknown');
        assert.equal((await db.query("SELECT * FROM requests WHERE session='unknown'")).rowCount,1);
        assert.equal((await db.query("SELECT * FROM effects WHERE session='unknown'")).rowCount,0);
    }finally{
        await db?.end();if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
    }
});
}
