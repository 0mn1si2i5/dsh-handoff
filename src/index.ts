import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import type { HandoffConfig } from './types.ts'

export const name = 'dsh-handoff'
export const inject = ['commands', 'sessionQuery', 'llm', 'fs', 'subprocess']
export { Config }
export type { HandoffConfig }

export function apply(_ctx: Context, _config: HandoffConfig = {}): void {}
