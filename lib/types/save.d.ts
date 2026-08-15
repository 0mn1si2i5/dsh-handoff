import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedHandoffConfig } from './types.ts';
export interface SaveResult {
    readonly path: 'docs/handoffs/current.md';
    readonly capturedThroughSeq: number | null;
    readonly digest: string;
    readonly redactionCount: number;
}
export interface SaveOptions {
    readonly env: NodeJS.ProcessEnv;
    readonly now: () => Date;
}
export declare function saveHandoff(ctx: Context, agent: Agent, config: ResolvedHandoffConfig, signal: AbortSignal | undefined, options: SaveOptions): Promise<SaveResult>;
