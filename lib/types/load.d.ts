import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { HANDOFF_PATH } from './storage.ts';
import type { ResolvedHandoffConfig } from './types.ts';
export type LoadResult = {
    readonly kind: 'loaded';
    readonly path: typeof HANDOFF_PATH;
    readonly digest: string;
    readonly stale: boolean;
} | {
    readonly kind: 'already-loaded';
    readonly path: typeof HANDOFF_PATH;
    readonly digest: string;
};
export declare function loadHandoff(ctx: Context, agent: Agent, config: ResolvedHandoffConfig, signal: AbortSignal | undefined): Promise<LoadResult>;
