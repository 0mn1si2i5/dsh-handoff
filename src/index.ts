import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import { registerHandoffCommand } from './command.ts'
import type { HandoffConfig } from './types.ts'

export const name = 'dsh-handoff'
export const inject = ['commands', 'sessionQuery', 'llm', 'fs', 'subprocess']
export { Config }
export type { HandoffConfig }

export function apply(ctx: Context, config: HandoffConfig = {}): void {
  registerHandoffCommand(ctx, resolveConfig(config))
}
