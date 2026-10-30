import pg from "pg";
import { mockAgentModel, modelTool, modelText } from "./agent-model.js";
const mode=process.argv[3];
const freeze=async () => {
    await new Promise<void>(resolve => process.stdout.write("AGENT_CRASH_POINT\n",() => resolve()));
    await new Promise(() => undefined);
};
const fixture=mockAgentModel(["during_model","summary_during_model"].includes(mode) ? [freeze] : mode.startsWith("summary_") ? [modelText("原历史摘要，保留目标与未完成事项。 ")] : [modelTool("create_text_nodes",{nodes:[{title:"中断恢复镜头",text:"只创建一次",sourceNodeIds:[]}]})]);
const original=pg.Client.prototype.query;
pg.Client.prototype.query=async function (this:pg.Client & {agentProbeReceipt?:boolean;agentSummarySaved?:boolean;agentSummaryApplied?:boolean},...args:any[]) {
    const result=await (original as any).apply(this,args);
    const sql=typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (sql?.startsWith("INSERT INTO agent_tool_receipts")) {
        this.agentProbeReceipt=true;
        if (mode === "before_commit") await freeze();
    }
    if (sql?.startsWith("UPDATE agent_steps SET status='decided'")) this.agentSummarySaved=true;
    if (sql?.startsWith("UPDATE agent_runs SET context_checkpoint=$2")) this.agentSummaryApplied=true;
    if (sql === "COMMIT" && (mode === "summary_saved" && this.agentSummarySaved || mode === "summary_applied" && this.agentSummaryApplied)) await freeze();
    if (sql === "COMMIT" && this.agentProbeReceipt && mode === "after_commit") await freeze();
    return result;
} as any;
const {executeAgentRun}=await import("../agent/worker.js");
await executeAgentRun(process.argv[2]);
fixture.restore();
const {db}=await import("../db.js");
await db.end();
