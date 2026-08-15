import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import CommandService, { CommandId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HandoffError } from '../src/error.ts'
import { HANDOFF_PATH } from '../src/storage.ts'
import { resolveConfig } from '../src/config.ts'
import { saveHandoff } from '../src/save.ts'
import { loadHandoff } from '../src/load.ts'
import { registerHandoffCommand } from '../src/command.ts'
import type { ResolvedHandoffConfig } from '../src/types.ts'
import type { SaveResult } from '../src/save.ts'
import type { LoadResult } from '../src/load.ts'

vi.mock('../src/save.ts', () => ({ saveHandoff: vi.fn() }))
vi.mock('../src/load.ts', () => ({ loadHandoff: vi.fn() }))

const USAGE = 'Usage: /handoff save | /handoff load'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Mount {
  ctx: Context
  fiber: Fiber
  agent: Agent
}

async function mount(config: ResolvedHandoffConfig = resolveConfig({})): Promise<Mount> {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  const fiber = await ctx.plugin(
    Object.assign((inner: Context) => {
      registerHandoffCommand(inner, config)
    }, { inject: ['commands'] }),
  )
  const agent = { id: SessionId('command-agent') } as Agent
  return { ctx, fiber, agent }
}

function invoke(mount: Mount, rawInput: string, signal: AbortSignal = new AbortController().signal): CommandResult | Promise<CommandResult> {
  const definition = mount.ctx.commands.find(mount.agent, 'handoff')
  if (definition === undefined) throw new Error('handoff command is not registered')
  return definition.handler({ commandId: CommandId('test-command'), agent: mount.agent, rawInput, signal })
}

beforeEach(() => {
  vi.mocked(saveHandoff).mockReset()
  vi.mocked(loadHandoff).mockReset()
})

describe('registerHandoffCommand', () => {
  it('advertises the handoff descriptor', async () => {
    const m = await mount()
    const listed = m.ctx.commands.list(m.agent)
    expect(listed.find((item) => item.name === 'handoff')).toMatchObject({
      name: 'handoff',
      description: 'Save or load the development handoff document',
      input: { hint: 'save | load' },
    })
    await m.ctx.fiber.dispose()
  })

  it.each([
    ['empty input', ''],
    ['unknown token', ' delete'],
    ['extra token', ' save extra'],
    ['capitalized token', ' Save'],
    ['prefixed token', ' save-all'],
  ] as const)('rejects %s with the exact usage text', async (_label, rawInput) => {
    const m = await mount()
    await expect(invoke(m, rawInput)).resolves.toEqual({ kind: 'error', text: USAGE })
    await m.ctx.fiber.dispose()
  })

  it('renders the save success text', async () => {
    vi.mocked(saveHandoff).mockResolvedValue({
      path: HANDOFF_PATH,
      capturedThroughSeq: 12,
      digest: 'd'.repeat(64),
      redactionCount: 2,
    } satisfies SaveResult)
    const m = await mount()
    await expect(invoke(m, ' save')).resolves.toEqual({
      kind: 'success',
      text: 'Saved docs/handoffs/current.md through session seq 12 (2 secrets redacted).',
    })
    await m.ctx.fiber.dispose()
  })

  it('renders a literal null for a missing captured-through seq', async () => {
    vi.mocked(saveHandoff).mockResolvedValue({
      path: HANDOFF_PATH,
      capturedThroughSeq: null,
      digest: 'd'.repeat(64),
      redactionCount: 0,
    } satisfies SaveResult)
    const m = await mount()
    await expect(invoke(m, ' save')).resolves.toEqual({
      kind: 'success',
      text: 'Saved docs/handoffs/current.md through session seq null (0 secrets redacted).',
    })
    await m.ctx.fiber.dispose()
  })

  it.each([
    [0, '0 secrets redacted'],
    [1, '1 secret redacted'],
    [3, '3 secrets redacted'],
  ] as const)('renders %d redaction(s) as "%s"', async (count, suffix) => {
    vi.mocked(saveHandoff).mockResolvedValue({
      path: HANDOFF_PATH,
      capturedThroughSeq: 12,
      digest: 'd'.repeat(64),
      redactionCount: count,
    } satisfies SaveResult)
    const m = await mount()
    await expect(invoke(m, ' save')).resolves.toEqual({
      kind: 'success',
      text: `Saved docs/handoffs/current.md through session seq 12 (${suffix}).`,
    })
    await m.ctx.fiber.dispose()
  })

  it('renders the normal load text', async () => {
    vi.mocked(loadHandoff).mockResolvedValue({
      kind: 'loaded',
      path: HANDOFF_PATH,
      digest: 'd'.repeat(64),
      stale: false,
    } satisfies LoadResult)
    const m = await mount()
    await expect(invoke(m, ' load')).resolves.toEqual({
      kind: 'success',
      text: 'Loaded docs/handoffs/current.md. Send the next development instruction.',
    })
    await m.ctx.fiber.dispose()
  })

  it('renders the stale load warning text', async () => {
    vi.mocked(loadHandoff).mockResolvedValue({
      kind: 'loaded',
      path: HANDOFF_PATH,
      digest: 'd'.repeat(64),
      stale: true,
    } satisfies LoadResult)
    const m = await mount()
    await expect(invoke(m, ' load')).resolves.toEqual({
      kind: 'success',
      text: 'Loaded docs/handoffs/current.md with a repository-state warning; current files take precedence. Send the next development instruction.',
    })
    await m.ctx.fiber.dispose()
  })

  it('renders the already-loaded text', async () => {
    vi.mocked(loadHandoff).mockResolvedValue({
      kind: 'already-loaded',
      path: HANDOFF_PATH,
      digest: 'd'.repeat(64),
    } satisfies LoadResult)
    const m = await mount()
    await expect(invoke(m, ' load')).resolves.toEqual({
      kind: 'success',
      text: 'docs/handoffs/current.md is already loaded in this session.',
    })
    await m.ctx.fiber.dispose()
  })

  it.each(['busy', 'cancelled', 'git', 'model', 'document', 'filesystem'] as const)(
    'maps the %s HandoffError code to an error result',
    async (code) => {
      vi.mocked(saveHandoff).mockRejectedValue(new HandoffError(code, `failed with ${code}`))
      const m = await mount()
      await expect(invoke(m, ' save')).resolves.toEqual({ kind: 'error', text: `failed with ${code}` })
      await m.ctx.fiber.dispose()
    },
  )

  it('rethrows an unexpected error unchanged', async () => {
    vi.mocked(saveHandoff).mockRejectedValue(new Error('boom'))
    const m = await mount()
    await expect(invoke(m, ' save')).rejects.toThrow('boom')
    await m.ctx.fiber.dispose()
  })

  it('removes the command when its plugin fiber is disposed', async () => {
    const m = await mount()
    expect(m.ctx.commands.find(m.agent, 'handoff')).toBeDefined()
    await m.fiber.dispose()
    expect(m.ctx.commands.find(m.agent, 'handoff')).toBeUndefined()
    await m.ctx.fiber.dispose()
  })

  it('aborts an in-flight save when the fiber is disposed', async () => {
    vi.mocked(saveHandoff).mockImplementation(
      (_ctx, _agent, _config, signal) =>
        new Promise<SaveResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new HandoffError('cancelled', 'save was cancelled')), {
            once: true,
          })
        }),
    )
    const m = await mount()
    const pending = invoke(m, ' save')
    const disposePromise = m.fiber.dispose()
    await expect(pending).resolves.toEqual({ kind: 'error', text: 'save was cancelled' })
    await disposePromise
    await m.ctx.fiber.dispose()
  })

  it('waits for an in-flight operation to settle before finishing disposal', async () => {
    const gate = deferred<void>()
    vi.mocked(saveHandoff).mockImplementation(
      (_ctx, _agent, _config, signal) =>
        new Promise<SaveResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              void gate.promise.then(() => reject(new HandoffError('cancelled', 'save was cancelled')))
            },
            { once: true },
          )
        }),
    )
    const m = await mount()
    const pending = invoke(m, ' save')
    const disposePromise = m.fiber.dispose()

    let settled = false
    void disposePromise.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    gate.resolve()
    await disposePromise
    expect(settled).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'error', text: 'save was cancelled' })
    await m.ctx.fiber.dispose()
  })

  it('does not abort an already-settled operation on disposal', async () => {
    let captured: AbortSignal | undefined
    vi.mocked(saveHandoff).mockImplementation((_ctx, _agent, _config, signal) => {
      captured = signal
      return Promise.resolve({
        path: HANDOFF_PATH,
        capturedThroughSeq: 12,
        digest: 'd'.repeat(64),
        redactionCount: 0,
      } satisfies SaveResult)
    })
    const m = await mount()
    await invoke(m, ' save')
    expect(captured?.aborted).toBe(false)
    await m.fiber.dispose()
    expect(captured?.aborted).toBe(false)
    await m.ctx.fiber.dispose()
  })
})
