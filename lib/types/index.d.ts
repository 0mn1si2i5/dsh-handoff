import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
import type { HandoffConfig } from './types.ts';
export declare const name = "dsh-handoff";
export declare const inject: string[];
export { Config };
export type { HandoffConfig };
export declare function apply(ctx: Context, config?: HandoffConfig): void;
