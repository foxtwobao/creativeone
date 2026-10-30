import { cloudApi } from "./cloud";
import type { AgentSettingsRecord } from "../../../../shared/agent-settings";

export const getAdminAgentSettings=()=>cloudApi<{settings:AgentSettingsRecord}>("/admin/agent");
export const saveAdminAgentSettings=(settings:AgentSettingsRecord)=>cloudApi<{settings:AgentSettingsRecord}>("/admin/agent",{method:"PUT",body:JSON.stringify(settings)});
