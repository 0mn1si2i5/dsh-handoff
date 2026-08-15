import z from '@deepseek-ai/schemastery';
import type { HandoffConfig, ResolvedHandoffConfig } from './types.ts';
export declare const Config: z<HandoffConfig>;
export declare function resolveConfig(config: HandoffConfig): ResolvedHandoffConfig;
