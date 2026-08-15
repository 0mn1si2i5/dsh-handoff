import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedHandoffConfig } from './types.ts';
/**
 * Register the strict `/handoff save | /handoff load` command.
 *
 * Every invocation owns an independent AbortController fused with the UI
 * request signal; the controller and its operation are tracked in one map and
 * retired as soon as the operation settles, so the effect disposer aborts and
 * drains exactly the work still in flight.
 */
export declare function registerHandoffCommand(ctx: Context, config: ResolvedHandoffConfig): void;
