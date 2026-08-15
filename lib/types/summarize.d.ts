import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RedactionCounts, ResolvedHandoffConfig, SummarySections } from './types.ts';
export interface SummarizeRequest {
    readonly agent: Agent;
    readonly messages: readonly Message[];
    readonly config: ResolvedHandoffConfig;
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
}
export type SummarizeStream = (options: GenerateOptions) => AsyncIterable<StreamChunk>;
export declare function summarizeHandoff(stream: SummarizeStream, request: SummarizeRequest): Promise<{
    summary: SummarySections;
    redactions: RedactionCounts;
}>;
