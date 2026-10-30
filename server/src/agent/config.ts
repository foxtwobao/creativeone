import { z } from "zod";

const positive = z.number().int().positive();
// Defaults explicitly confirmed for this implementation; no SDK automatic retries.
export const agentConfigSchema = z.object({
    verifiedModels: z.array(z.object({ model: z.string().min(1), protocol: z.literal("responses"), imageInput: z.boolean() }).strict()).min(1),
    verifiedMediaModels: z.array(z.string().min(1)),
    globalConcurrency: positive.default(2), accountConcurrency: positive.default(1), inputCharacters: positive.default(120000),
    decisionBudget: positive.default(24), contextTokens: positive.default(260000), recentContextTokens: positive.default(64000), summaryTokens: positive.default(16000), outputTokens: positive.optional(),
    nodeBatch: positive.default(50), mediaBatch: positive.default(8), requestTimeoutMs: positive.default(600000), scanIntervalMs: positive.default(5000), pollIntervalMs: positive.default(3000),
}).strict().refine(value => value.accountConcurrency <= value.globalConcurrency && value.recentContextTokens+value.summaryTokens < value.contextTokens);
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export const agentConfig = process.env.SERVER_AGENT_CONFIG ? agentConfigSchema.parse(JSON.parse(process.env.SERVER_AGENT_CONFIG)) : null;
export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_STORAGE_VERSION = 1;
