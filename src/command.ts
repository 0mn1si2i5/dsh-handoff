import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HandoffError } from './error.ts'
import { saveHandoff } from './save.ts'
import type { SaveResult } from './save.ts'
import { loadHandoff } from './load.ts'
import type { LoadResult } from './load.ts'
import type { ResolvedHandoffConfig } from './types.ts'

const USAGE = 'Usage: /handoff save | /handoff load'

/** Fail loudly if the closed error-code union gains an unhandled member. */
function assertNever(value: never): never {
  throw new TypeError(`unknown handoff error code: ${String(value)}`)
}

function pluralize(count: number): string {
  return count === 1 ? 'secret' : 'secrets'
}

function saveText(result: SaveResult): string {
  const seq = result.capturedThroughSeq === null ? 'null' : String(result.capturedThroughSeq)
  return `Saved ${result.path} through session seq ${seq} (${result.redactionCount} ${pluralize(result.redactionCount)} redacted).`
}

function loadText(result: LoadResult): string {
  if (result.kind === 'already-loaded') {
    return 'docs/handoffs/current.md is already loaded in this session.'
  }
  if (result.stale) {
    return 'Loaded docs/handoffs/current.md with a repository-state warning; current files take precedence. Send the next development instruction.'
  }
  return 'Loaded docs/handoffs/current.md. Send the next development instruction.'
}

const ACK_PLUGIN = 'dsh-handoff'

/** One-line notice account plus the model-facing confirmation prompt. */
interface HandoffAck {
  summary: string
  instruction: string
}

/**
 * Ask the model to report a completed operation. A `/handoff` command renders
 * as a flow node, not a conversation turn, so without this follow-up the
 * assistant stays silent and a fresh thread shows nothing but the command
 * lifecycle. The follow-up message is a `notice` (a one-off account of what
 * just happened) and wakes the model for one short confirmation turn.
 */
function acknowledge(agent: Agent, ack: HandoffAck): void {
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: ack.instruction }],
      source: { kind: 'plugin', plugin: ACK_PLUGIN, form: 'notice', summary: ack.summary },
    }),
  )
}

function handoffFailure(error: HandoffError): CommandResult {
  switch (error.code) {
    case 'busy':
    case 'cancelled':
    case 'git':
    case 'model':
    case 'document':
    case 'filesystem':
      return { kind: 'error', text: error.message }
    default:
      return assertNever(error.code)
  }
}

async function executeHandoff(
  ctx: Context,
  invocation: CommandInvocation,
  config: ResolvedHandoffConfig,
  signal: AbortSignal,
): Promise<CommandResult> {
  const tokens = invocation.rawInput.trim().split(/\s+/u)
  const token = tokens[0]
  if (tokens.length !== 1 || (token !== 'save' && token !== 'load')) {
    return { kind: 'error', text: USAGE }
  }
  try {
    if (token === 'save') {
      const result = await saveHandoff(ctx, invocation.agent, config, signal, {
        env: process.env,
        now: () => new Date(),
      })
      acknowledge(invocation.agent, {
        summary: `Saved ${result.path}`,
        instruction: `The development handoff document was saved to ${result.path}. Briefly confirm this to the user.`,
      })
      return { kind: 'success', text: saveText(result) }
    }
    const result = await loadHandoff(ctx, invocation.agent, config, signal)
    acknowledge(
      invocation.agent,
      result.kind === 'already-loaded'
        ? {
            summary: `Already loaded ${result.path}`,
            instruction: 'The development handoff document is already loaded in this session. Briefly confirm this to the user.',
          }
        : {
            summary: `Loaded ${result.path}`,
            instruction: 'The development handoff document was loaded. Briefly confirm this to the user.',
          },
    )
    return { kind: 'success', text: loadText(result) }
  } catch (error: unknown) {
    if (error instanceof HandoffError) return handoffFailure(error)
    throw error
  }
}

/**
 * Register the strict `/handoff save | /handoff load` command.
 *
 * Every invocation owns an independent AbortController fused with the UI
 * request signal; the controller and its operation are tracked in one map and
 * retired as soon as the operation settles, so the effect disposer aborts and
 * drains exactly the work still in flight.
 */
export function registerHandoffCommand(ctx: Context, config: ResolvedHandoffConfig): void {
  const active = new Map<AbortController, Promise<CommandResult>>()

  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const controller = new AbortController()
    const signal = AbortSignal.any([invocation.signal, controller.signal])
    const operation = executeHandoff(ctx, invocation, config, signal)
    active.set(controller, operation)
    const retire = (): void => {
      active.delete(controller)
    }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield the drain disposer first: LIFO teardown runs the registration
    // disposer (below) before this one, so the command leaves the registry —
    // blocking new invocations — before every started operation is aborted and
    // awaited to quiescence.
    yield async () => {
      const controllers = [...active.keys()]
      const operations = [...active.values()]
      for (const controller of controllers) controller.abort(new Error('handoff command disposed'))
      await Promise.allSettled(operations)
    }
    yield ctx.commands.register({
      name: 'handoff',
      description: 'Save or load the development handoff document',
      input: { hint: 'save | load' },
      handler,
    })
  })
}
