export const agentSettingsDefaults={
    enabled:false,globalConcurrency:2,accountConcurrency:1,inputCharacters:120000,
    decisionBudget:24,modelRetries:5,contextTokens:260000,recentContextTokens:64000,summaryTokens:16000,outputTokens:null,
    nodeBatch:50,mediaBatch:8,requestTimeoutMs:600000,scanIntervalMs:5000,pollIntervalMs:3000,
};
export type AgentSettings=Omit<typeof agentSettingsDefaults,"outputTokens">&{outputTokens:number|null};
export type AgentSettingsRecord=AgentSettings&{revision:number};
export type ModelCapabilities={agentEnabled:boolean;imageInput:boolean};
