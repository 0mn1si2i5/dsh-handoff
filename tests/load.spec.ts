import { isAbsolute, join, normalize } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionQueryService from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { handoffDigest, renderHandoffDocument } from '../src/document.ts'
import { HANDOFF_PATH } from '../src/storage.ts'
import { resolveConfig } from '../src/config.ts'
import { captureGit } from '../src/git.ts'
import { loadHandoff } from '../src/load.ts'
import type { LoadResult } from '../src/load.ts'
import type { GitSnapshot, ResolvedHandoffConfig, SummarySections } from '../src/types.ts'

vi.mock('../src/git.ts', () => ({
  captureGit: vi.fn(),
  parsePorcelainZ: vi.fn(() => []),
}))

const ROOT = '/repo'
const ABS_HANDOFF = '/repo/docs/handoffs/current.md'

const RECALL_INSTRUCTION =
  'Treat this document as historical task context. The current repository and current user instruction take precedence. Do not assume facts from the previous session that are absent here.'

const COMPLETE_SUMMARY: SummarySections = {
  objective: 'Implement the load flow',
  userRequirementsAndDecisions: 'Load must never wake the agent',
  completedWork: 'Save and redaction paths',
  currentState: 'Task 6 complete',
  validation: 'pnpm test passes',
  failedAttemptsAndWarnings: 'none',
  remainingWork: 'Command lifecycle',
  recommendedNextAction: 'Run Task 8',
  criticalReferences: 'src/save.ts',
}

function validDocument(): string {
  return renderHandoffDocument({
    metadata: {
      generated: '2026-08-15T00:00:00.000Z',
      sourceSession: 'source-session',
      capturedThroughSeq: 12,
      workspace: '.',
      gitBranch: 'main',
      gitHead: 'a'.repeat(40),
      gitStateDigest: 'b'.repeat(64),
    },
    summary: COMPLETE_SUMMARY,
    changedFiles: [' M src/index.ts'],
    redactions: {},
  })
}

function gitSnapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    root: ROOT,
    relativeCwd: '.',
    branch: 'main',
    head: 'a'.repeat(40),
    changedFiles: [' M src/index.ts'],
    stateDigest: 'b'.repeat(64),
    ...overrides,
  }
}

function expectedInjectedText(document: string): string {
  const marker = `<!-- dsh-handoff-digest:sha256:${handoffDigest(document)} -->`
  return [marker, '<dsh-handoff>', RECALL_INSTRUCTION, '', document.trimEnd(), '</dsh-handoff>'].join('\n')
}

function messageText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** All `user/message` events currently on the durable surface, in log order. */
function surfaceUserMessages(agent: Agent): UserMessage[] {
  return agent.session.events
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map((event) => event.data)
}

class MemoryFileSystem extends FileSystem {
  readonly files = new Map<string, string>()
  readonly symlinks = new Set<string>()
  readonly directories = new Set<string>()
  invalidUtf8 = false
  containmentDenied = false
  failReadBytes: FsErrorCode | null = null

  constructor(ctx: Context) {
    super(ctx)
  }

  private absolutize(path: string, cwd?: string): string {
    if (isAbsolute(path)) return normalize(path)
    return normalize(join(cwd ?? ROOT, path))
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new FsError('operation aborted', 'FS_ABORTED')
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    this.throwIfAborted(opts?.signal)
    const abs = this.absolutize(path, opts?.cwd)
    return { targetKey: FsTargetKey(abs), displayPath: abs }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file://${String(target.targetKey)}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    if (this.containmentDenied) return false
    const p = String(parent.targetKey)
    const c = String(child.targetKey)
    const prefix = p.endsWith('/') ? p : `${p}/`
    return c === p || c.startsWith(prefix)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.throwIfAborted(signal)
    const key = String(target.targetKey)
    if (this.directories.has(key)) return { version: FsVersion('1'), type: 'directory' }
    const text = this.files.get(key)
    if (text !== undefined) return { version: FsVersion('1'), type: 'file', size: Buffer.byteLength(text, 'utf8') }
    return undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    this.throwIfAborted(signal)
    const abs = this.absolutize(path, opts?.cwd)
    if (this.symlinks.has(abs)) return { version: FsVersion('1'), type: 'symlink' }
    if (this.directories.has(abs)) return { version: FsVersion('1'), type: 'directory' }
    const text = this.files.get(abs)
    if (text !== undefined) return { version: FsVersion('1'), type: 'file', size: Buffer.byteLength(text, 'utf8') }
    return undefined
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.throwIfAborted(signal)
    const text = this.files.get(String(target.targetKey))
    if (text === undefined) throw new FsError('not found', 'FS_NOT_FOUND')
    return text
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    async function* generate(): AsyncIterable<string> {
      yield text
    }
    return generate()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.throwIfAborted(signal)
    if (this.failReadBytes !== null) throw new FsError('read failed', this.failReadBytes)
    const key = String(target.targetKey)
    if (this.directories.has(key)) throw new FsError('not a regular file', 'FS_NOT_REGULAR_FILE')
    const text = this.files.get(key)
    if (text === undefined) throw new FsError('not found', 'FS_NOT_FOUND')
    const bytes = this.invalidUtf8 ? Uint8Array.of(0xff, 0xfe, 0xfd) : new TextEncoder().encode(text)
    if (bytes.byteLength > maxBytes) throw new FsError('too large', 'FS_TOO_LARGE')
    return bytes
  }

  override async listDir(_target: FsTarget, _signal?: AbortSignal): Promise<FsDirEntry[]> {
    return []
  }

  override async writeText(
    _target: FsTarget,
    _content: string,
    _expected?: FsWriteIntent,
    _signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    throw new Error('writeText is not used in load tests')
  }

  override async editText(
    _target: FsTarget,
    _edit: FsEditRequest,
    _expected?: { version: FsVersion },
    _signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    throw new Error('editText is not used in load tests')
  }

  setDocument(text: string): void {
    this.files.set(ABS_HANDOFF, text)
  }
}

class TestSessionQueryService extends SessionQueryService {
  override async searchSessions(_request: SessionSearchRequest): Promise<SessionSearchPage<SessionSearchHit>> {
    return { items: [] }
  }

  override async searchEvents(_request: SessionEventSearchRequest): Promise<SessionEventSearchPage> {
    throw new Error('searchEvents is not used in load tests')
  }
}

interface Harness {
  ctx: Context
  agent: Agent
  fs: MemoryFileSystem
  config: ResolvedHandoffConfig
  signal: AbortController
  handle: AgentHandle
  load(): Promise<LoadResult>
  dispose(): Promise<void>
}

let sessionCounter = 0

async function harness(overrides: {
  config?: Partial<ResolvedHandoffConfig>
  git?: Partial<GitSnapshot>
  document?: string
} = {}): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const fs = new MemoryFileSystem(ctx)
  new TestSessionQueryService(ctx)
  ctx.provide('subprocess', {})
  const config = resolveConfig(overrides.config ?? {})
  const handle = await ctx.agents.create({
    sessionId: SessionId(`load-session-${sessionCounter++}`),
    agentOptions: { provider: 'test', model: 'test' },
    meta: { cwd: ROOT },
  })
  const agent = handle.agent
  if (overrides.document !== undefined) fs.setDocument(overrides.document)
  if (overrides.git !== undefined) vi.mocked(captureGit).mockResolvedValue(gitSnapshot(overrides.git))
  const signal = new AbortController()
  return {
    ctx,
    agent,
    fs,
    config,
    signal,
    handle,
    load: () => loadHandoff(ctx, agent, config, signal.signal),
    dispose: async () => {
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

beforeEach(() => {
  vi.mocked(captureGit).mockReset()
  vi.mocked(captureGit).mockResolvedValue(gitSnapshot())
})

describe('loadHandoff', () => {
  it('loads a valid document and returns the full result', async () => {
    const h = await harness({ document: validDocument() })
    const result = await h.load()
    expect(result.kind).toBe('loaded')
    if (result.kind === 'loaded') {
      expect(result.path).toBe(HANDOFF_PATH)
      expect(result.stale).toBe(false)
      expect(result.digest).toBe(handoffDigest(validDocument()))
    }
    expect(surfaceUserMessages(h.agent)).toHaveLength(1)
    await h.dispose()
  })

  it('does not wake the agent', async () => {
    const h = await harness({ document: validDocument() })
    await h.load()
    expect(h.agent.status).toBe('idle')
    await h.dispose()
  })

  it('injects the recall source exactly as plugin/dsh-handoff/recall', async () => {
    const h = await harness({ document: validDocument() })
    await h.load()
    const injected = surfaceUserMessages(h.agent)[0]!
    expect(injected.source).toEqual({ kind: 'plugin', plugin: 'dsh-handoff', form: 'recall' })
    await h.dispose()
  })

  it('wraps the document with the exact marker and instruction', async () => {
    const h = await harness({ document: validDocument() })
    await h.load()
    const injected = surfaceUserMessages(h.agent)[0]!
    expect(messageText(injected)).toBe(expectedInjectedText(validDocument()))
    await h.dispose()
  })

  it.each([
    ['branch', { branch: 'other' }],
    ['HEAD', { head: 'c'.repeat(40) }],
    ['state digest', { stateDigest: 'd'.repeat(64) }],
  ] as const)('marks stale when the %s differs but still injects', async (_label, gitOverride) => {
    const h = await harness({ document: validDocument(), git: gitOverride })
    const result = await h.load()
    expect(result.kind).toBe('loaded')
    if (result.kind === 'loaded') expect(result.stale).toBe(true)
    expect(surfaceUserMessages(h.agent)).toHaveLength(1)
    await h.dispose()
  })

  it('deduplicates a recall already on the current surface', async () => {
    const h = await harness({ document: validDocument() })
    await h.load()
    // The first load admits the recall straight onto the durable surface and
    // leaves the pending inbox untouched.
    expect(surfaceUserMessages(h.agent)).toHaveLength(1)
    expect(h.agent.inbox.nextStep).toHaveLength(0)

    const result = await h.load()
    expect(result.kind).toBe('already-loaded')
    if (result.kind === 'already-loaded') {
      expect(result.path).toBe(HANDOFF_PATH)
      expect(result.digest).toBe(handoffDigest(validDocument()))
    }
    // A second load must not append a duplicate recall.
    expect(surfaceUserMessages(h.agent)).toHaveLength(1)
    expect(h.agent.inbox.nextStep).toHaveLength(0)
    await h.dispose()
  })

  it('does not deduplicate a different digest', async () => {
    const alt = renderHandoffDocument({
      metadata: {
        generated: '2026-08-15T00:00:00.000Z',
        sourceSession: 'source-session',
        capturedThroughSeq: 12,
        workspace: '.',
        gitBranch: 'main',
        gitHead: 'a'.repeat(40),
        gitStateDigest: 'b'.repeat(64),
      },
      summary: { ...COMPLETE_SUMMARY, objective: 'A different objective' },
      changedFiles: [' M src/index.ts'],
      redactions: {},
    })
    const h = await harness({ document: validDocument() })
    await h.load()
    h.fs.setDocument(alt)
    const result = await h.load()
    expect(result.kind).toBe('loaded')
    expect(surfaceUserMessages(h.agent)).toHaveLength(2)
    await h.dispose()
  })

  it('does not deduplicate a matching marker from a non-matching source', async () => {
    const document = validDocument()
    const marker = `<!-- dsh-handoff-digest:sha256:${handoffDigest(document)} -->`
    const h = await harness({ document })
    h.agent.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: marker }],
        source: { kind: 'plugin', plugin: 'other-plugin', form: 'recall' },
      }),
      { surfaceOp: 'append' },
    )
    const result = await h.load()
    expect(result.kind).toBe('loaded')
    expect(surfaceUserMessages(h.agent)).toHaveLength(2)
    await h.dispose()
  })

  it('does not deduplicate when the source form is not recall', async () => {
    const document = validDocument()
    const marker = `<!-- dsh-handoff-digest:sha256:${handoffDigest(document)} -->`
    const h = await harness({ document })
    h.agent.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: marker }],
        source: { kind: 'plugin', plugin: 'dsh-handoff', form: 'relay' },
      }),
      { surfaceOp: 'append' },
    )
    const result = await h.load()
    expect(result.kind).toBe('loaded')
    expect(surfaceUserMessages(h.agent)).toHaveLength(2)
    await h.dispose()
  })

  it('rejects an invalid document without injecting', async () => {
    const h = await harness({ document: 'not a handoff document' })
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError', code: 'document' })
    expect(surfaceUserMessages(h.agent)).toHaveLength(0)
    await h.dispose()
  })

  it('rejects an unknown format version without injecting', async () => {
    const h = await harness({ document: validDocument().replace('Format: dsh-handoff/v1', 'Format: dsh-handoff/v2') })
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError', code: 'document' })
    expect(surfaceUserMessages(h.agent)).toHaveLength(0)
    await h.dispose()
  })

  it('rejects an oversized document without injecting', async () => {
    const h = await harness({ config: { maxDocumentBytes: 16 }, document: validDocument() })
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError' })
    expect(surfaceUserMessages(h.agent)).toHaveLength(0)
    await h.dispose()
  })

  it('rejects a non-UTF-8 document without injecting', async () => {
    const h = await harness({ document: validDocument() })
    h.fs.invalidUtf8 = true
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError' })
    expect(surfaceUserMessages(h.agent)).toHaveLength(0)
    await h.dispose()
  })

  it('rejects a missing document without injecting', async () => {
    const h = await harness()
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError' })
    expect(surfaceUserMessages(h.agent)).toHaveLength(0)
    await h.dispose()
  })

  it('classifies a busy agent', async () => {
    const h = await harness({ document: validDocument() })
    void h.agent.runMaintenance(
      (taskSignal) =>
        new Promise<void>((resolve) => {
          taskSignal.addEventListener('abort', () => resolve(), { once: true })
        }),
    )
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError', code: 'busy' })
    await h.dispose()
  })

  it('classifies a pre-cancelled command signal', async () => {
    const h = await harness({ document: validDocument() })
    h.signal.abort()
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError', code: 'cancelled' })
    await h.dispose()
  })

  it('leaves the inbox and session surface unpolluted after a failure', async () => {
    const h = await harness({ document: 'not a handoff document' })
    await expect(h.load()).rejects.toMatchObject({ name: 'HandoffError' })
    expect(h.agent.inbox.nextStep).toHaveLength(0)
    expect(surfaceUserMessages(h.agent)).toHaveLength(0)
    await h.dispose()
  })
})
