import { expect,test } from "bun:test";
import { agentToolErrorMessage,toolAction,type AgentEntry } from "./canvas-server-agent-format";

test("tool failures display the persisted field error",()=>{
    expect(agentToolErrorMessage({error:"AGENT_INVALID_TOOL_ARGUMENTS",message:"本次决定未执行，请根据字段问题修正。",details:{problems:[{field:"includeImages",message:"应为布尔值（true 或 false）"}]}})).toContain("includeImages：应为布尔值（true 或 false）");
});
test("browser requests display delivery without claiming execution",()=>{
    const entry={threadId:"thread",turnId:"turn",itemId:"item",role:"tool",text:"site_navigate",detail:{result:{browserStatus:"queued"}}} as AgentEntry;
    expect(toolAction(entry)).toBe("打开页面 · 请求已发送");
    entry.detail.result={browserStatus:"unavailable"};expect(toolAction(entry)).toBe("打开页面 · 未关联浏览器");
});
test("tool failures without field errors preserve their actual reason",()=>{
    expect(agentToolErrorMessage({error:"AGENT_TOOL_DEFERRED",message:"前序操作正在等待确认或结果，本项尚未执行。"})).toBe("前序操作正在等待确认或结果，本项尚未执行。");
    expect(agentToolErrorMessage({error:"AGENT_IMAGE_UNSUPPORTED"})).toContain("未启用图片理解");
    expect(agentToolErrorMessage({error:"AGENT_TOOL_FAILED"})).toBe("此步未完成，未提供具体原因。");
});
test("an answered question displays the received answer",()=>{
    const entry={threadId:"thread",turnId:"turn",itemId:"item",role:"tool",text:"request_user_input",detail:{result:{answers:{style:"写实"}}}} as AgentEntry;
    expect(toolAction(entry)).toBe("已收到用户补充");
});
