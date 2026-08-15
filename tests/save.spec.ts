import { isAbsolute, join, normalize } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { saveHandoff } from '../src/save.ts'
import type { SaveOptions, SaveResult } from '../src/save.ts'
import { HANDOFF_PATH, readHandoffText, resolveHandoffTarget, writeHandoffText } from '../src/storage.ts'
import { captureGit } from '../src/git.ts'
import { handoffDigest } from '../src/document.ts'
import { resolveConfig } from '../src/config.ts'
import type { GitSnapshot, ResolvedHandoffConfig } from '../src/types.ts'

vi.mock('../src/git.ts', () => ({
  captureGit: vi.fn(),
  parsePorcelainZ: vi.fn(() => []),
}))

const SUMMARY_HEADINGS = [
  'Objective',
  'User Requirements and Decisions',
  'Completed Work',
  'Current State',
  'Validation',
  'Failed Attempts and Warnings',
  'Remaining Work',
  'Recommended Next Action',
  'Critical References',
] as const

const ROOT = '/repo'
const ABS_HANDOFF = '/repo/docs/handoffs/current.md'

function summaryMarkdown(bodies: readonly string[] = []): string {
  return SUMMARY_HEADINGS.map((heading, index) => `## ${heading}\n${bodies[index] ?? `body-${index}`}`).join('\n\n')
}

function successChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function defaultStream(): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  const chunks = successChunks(summaryMarkdown())
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

function errorFinishStream(): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model boom', code: 'ERR' } } } as StreamChunk
  }
}

function neverSignal(): AbortSignal {
  return new AbortController().signal
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

function makeSeededSession(text?: string): Session {
  const id = SessionId('source-session')
  const header: SessionHeader = { version: 0, id, createdAt: 0, cwd: ROOT }
  const session = Session.create(id, [], header)
  if (text !== undefined) {
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
  }
  return session
}

class MemoryFileSystem extends FileSystem {
  readonly files = new Map<string, string>()
  readonly symlinks = new Set<string>()
  readonly directories = new Set<string>()
  readonly writes: Array<{ path: string; content: string; intent: FsWriteIntent | undefined }> = []
  lastWriteIntent: FsWriteIntent | undefined
  containmentDenied = false
  invalidUtf8 = false
  staleReplace = false
  failResolve: FsErrorCode | null = null
  failStat: FsErrorCode | null = null
  failReadBytes: FsErrorCode | null = null
  failWrite: FsErrorCode | null = null
  private versionCounter = 0
  private readonly versions = new Map<string, number>()

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

  private bumpVersion(key: string): FsVersion {
    const next = this.versionCounter + 1
    this.versionCounter = next
    this.versions.set(key, next)
    return FsVersion(String(next))
  }

  private versionFor(key: string): FsVersion {
    const existing = this.versions.get(key)
    if (existing !== undefined) return FsVersion(String(existing))
    return this.bumpVersion(key)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    this.throwIfAborted(opts?.signal)
    if (this.failResolve !== null) throw new FsError('resolve failed', this.failResolve)
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
    if (this.failStat !== null) throw new FsError('stat failed', this.failStat)
    const key = String(target.targetKey)
    if (this.directories.has(key)) return { version: this.versionFor(key), type: 'directory' }
    const text = this.files.get(key)
    if (text !== undefined) return { version: this.versionFor(key), type: 'file', size: Buffer.byteLength(text, 'utf8') }
    return undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    this.throwIfAborted(signal)
    if (this.failStat !== null) throw new FsError('lstat failed', this.failStat)
    const abs = this.absolutize(path, opts?.cwd)
    if (this.symlinks.has(abs)) return { version: this.versionFor(abs), type: 'symlink' }
    if (this.directories.has(abs)) return { version: this.versionFor(abs), type: 'directory' }
    const text = this.files.get(abs)
    if (text !== undefined) return { version: this.versionFor(abs), type: 'file', size: Buffer.byteLength(text, 'utf8') }
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
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    this.throwIfAborted(signal)
    if (this.failWrite !== null) throw new FsError('write failed', this.failWrite)
    const key = String(target.targetKey)
    this.lastWriteIntent = expected
    this.writes.push({ path: key, content, intent: expected })
    const exists = this.files.has(key)
    if (expected?.kind === 'createIfAbsent') {
      if (exists || this.symlinks.has(key) || this.directories.has(key)) {
        throw new FsError('target already exists', 'FS_NOT_OBSERVED')
      }
    } else if (expected?.kind === 'replaceIfVersion') {
      if (this.staleReplace || !exists || this.symlinks.has(key)) {
        throw new FsError('stale version', 'FS_STALE_VERSION')
      }
    }
    const before = this.files.get(key) ?? null
    this.files.set(key, content)
    return { operation: exists ? 'update' : 'create', version: this.bumpVersion(key), before, after: content }
  }

  override async editText(
    _target: FsTarget,
    _edit: FsEditRequest,
    _expected?: { version: FsVersion },
    _signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    throw new Error('editText is not implemented in the test filesystem')
  }
}

interface Harness {
  ctx: Context
  fs: MemoryFileSystem
  session: Session
  agent: Agent
  config: ResolvedHandoffConfig
  options: SaveOptions
  signal: AbortController
  streamCalls: GenerateOptions[]
  save(): Promise<SaveResult>
  cancelMaintenance(): void
  markBusy(): void
}

function harness(overrides: {
  session?: Session
  agentOptions?: AgentOptions
  config?: Partial<ResolvedHandoffConfig>
  env?: NodeJS.ProcessEnv
  capturedThroughSeq?: number | null
  surfaceEvents?: readonly SurfaceEvent[]
  stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
} = {}): Harness {
  const session = overrides.session ?? makeSeededSession()
  const fs = new MemoryFileSystem(new Context())
  const config = resolveConfig(overrides.config ?? {})
  const options: SaveOptions = { env: overrides.env ?? {}, now: () => new Date('2026-08-15T00:00:00.000Z') }
  const signal = new AbortController()
  const surface: SessionSurfaceSnapshot = {
    session: session.header,
    capturedThroughSeq: overrides.capturedThroughSeq ?? 12,
    events: (overrides.surfaceEvents ?? []) as SurfaceEvent[],
  }
  const sessionQuery = { readSurface: async () => surface }
  const streamCalls: GenerateOptions[] = []
  const stream = overrides.stream ?? defaultStream()
  const llm = {
    stream: (o: GenerateOptions): AsyncIterable<StreamChunk> => {
      streamCalls.push(o)
      return stream(o)
    },
  }
  const ctx = { sessionQuery, llm, subprocess: {}, fs } as unknown as Context

  let maintenanceController: AbortController | null = null
  let busy = false
  const agent = {
    id: session.id,
    options: overrides.agentOptions ?? { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: {},
    status: 'idle',
    ctx: {},
    cancel: () => maintenanceController?.abort(new Error('maintenance cancelled')),
    whenIdle: async () => {},
    runMaintenance: (task: (taskSignal: AbortSignal) => Promise<unknown>) => {
      if (busy) throw new Error('agent is busy')
      maintenanceController = new AbortController()
      return task(maintenanceController.signal)
    },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  } as unknown as Agent

  return {
    ctx,
    fs,
    session,
    agent,
    config,
    options,
    signal,
    streamCalls,
    save: () => saveHandoff(ctx, agent, config, signal.signal, options),
    cancelMaintenance: () => maintenanceController?.abort(new Error('maintenance cancelled')),
    markBusy: () => {
      busy = true
    },
  }
}

beforeEach(() => {
  vi.mocked(captureGit).mockReset()
  vi.mocked(captureGit).mockResolvedValue(gitSnapshot())
})

describe('storage', () => {
  it('creates a missing document with createIfAbsent', async () => {
    const fs = new MemoryFileSystem(new Context())
    await writeHandoffText(fs, ROOT, 'new content', neverSignal())
    expect(fs.files.get(ABS_HANDOFF)).toBe('new content')
    expect(fs.lastWriteIntent).toEqual({ kind: 'createIfAbsent' })
  })

  it('replaces an existing document with replaceIfVersion', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.files.set(ABS_HANDOFF, 'old content')
    await writeHandoffText(fs, ROOT, 'new content', neverSignal())
    expect(fs.files.get(ABS_HANDOFF)).toBe('new content')
    expect(fs.lastWriteIntent?.kind).toBe('replaceIfVersion')
  })

  it('rejects a symbolic-link handoff path', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.symlinks.add(ABS_HANDOFF)
    await expect(resolveHandoffTarget(fs, ROOT, neverSignal())).rejects.toMatchObject({
      name: 'HandoffError',
      code: 'filesystem',
    })
  })

  it('rejects a handoff path outside the repository', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.containmentDenied = true
    await expect(resolveHandoffTarget(fs, ROOT, neverSignal())).rejects.toMatchObject({
      name: 'HandoffError',
      code: 'filesystem',
    })
  })

  it('rejects a non-regular target', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.directories.add(ABS_HANDOFF)
    await expect(resolveHandoffTarget(fs, ROOT, neverSignal())).rejects.toMatchObject({
      name: 'HandoffError',
      code: 'filesystem',
    })
  })

  it('reads a bounded document with its observed version', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.files.set(ABS_HANDOFF, 'hello')
    const result = await readHandoffText(fs, ROOT, 1024, neverSignal())
    expect(result.text).toBe('hello')
    expect(typeof result.version).toBe('string')
  })

  it('rejects an oversized document through bounded readBytes', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.files.set(ABS_HANDOFF, 'x'.repeat(100))
    await expect(readHandoffText(fs, ROOT, 10, neverSignal())).rejects.toMatchObject({
      name: 'HandoffError',
      code: 'filesystem',
    })
  })

  it('rejects invalid UTF-8 with a fatal decoder', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.files.set(ABS_HANDOFF, 'placeholder')
    fs.invalidUtf8 = true
    await expect(readHandoffText(fs, ROOT, 1024, neverSignal())).rejects.toMatchObject({
      name: 'HandoffError',
      code: 'filesystem',
    })
  })

  it('preserves competitor content on a stale write', async () => {
    const fs = new MemoryFileSystem(new Context())
    fs.files.set(ABS_HANDOFF, 'competitor content')
    fs.staleReplace = true
    await expect(writeHandoffText(fs, ROOT, 'our content', neverSignal())).rejects.toMatchObject({
      name: 'HandoffError',
      code: 'filesystem',
    })
    expect(fs.files.get(ABS_HANDOFF)).toBe('competitor content')
  })
})

describe('saveHandoff', () => {
  it('saves a complete document and returns the full result', async () => {
    const h = harness()
    const result = await h.save()
    expect(result.path).toBe(HANDOFF_PATH)
    expect(result.capturedThroughSeq).toBe(12)
    expect(result.redactionCount).toBe(0)

    const written = h.fs.files.get(ABS_HANDOFF)
    expect(written).toBeDefined()
    expect(result.digest).toBe(handoffDigest(written!))
    expect(written).toContain('Captured through seq: 12')
    expect(written).toContain('Git branch: main')
    expect(written).toContain(' M src/index.ts')
  })

  it('captures git state from the session working directory', async () => {
    const h = harness()
    await h.save()
    expect(vi.mocked(captureGit).mock.calls[0]?.[1]).toBe(ROOT)
  })

  it('never mutates the source session surface', async () => {
    const session = makeSeededSession('original instruction')
    const beforeSeq = session.seq
    const beforeEvents = session.events
    const h = harness({ session })
    await h.save()
    expect(session.seq).toBe(beforeSeq)
    expect(session.events).toBe(beforeEvents)
  })

  it('classifies a busy agent', async () => {
    const h = harness()
    h.markBusy()
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'busy' })
  })

  it('classifies a pre-cancelled command signal', async () => {
    const h = harness()
    h.signal.abort()
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'cancelled' })
  })

  it('classifies a maintenance-signal cancellation', async () => {
    vi.mocked(captureGit).mockImplementation(
      (_subprocess, _cwd, signal) =>
        new Promise<GitSnapshot>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const h = harness()
    const pending = h.save()
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.cancelMaintenance()
    await expect(pending).rejects.toMatchObject({ name: 'HandoffError', code: 'cancelled' })
  })

  it('classifies git capture failures', async () => {
    vi.mocked(captureGit).mockRejectedValue(new Error('git boom'))
    const h = harness()
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'git' })
  })

  it('classifies model failures', async () => {
    const h = harness({ stream: errorFinishStream() })
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'model' })
  })

  it('preserves the old document when summarization fails', async () => {
    const h = harness({ stream: errorFinishStream() })
    h.fs.files.set(ABS_HANDOFF, 'old handoff')
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'model' })
    expect(h.fs.files.get(ABS_HANDOFF)).toBe('old handoff')
  })

  it('rejects an oversized document before touching the filesystem', async () => {
    const h = harness({ config: { maxDocumentBytes: 16 } })
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'document' })
    expect(h.fs.files.has(ABS_HANDOFF)).toBe(false)
  })

  it('classifies filesystem failures', async () => {
    const h = harness()
    h.fs.failWrite = 'FS_IO_ERROR'
    await expect(h.save()).rejects.toMatchObject({ name: 'HandoffError', code: 'filesystem' })
  })

  it('leaves no partial document on any pre-write failure', async () => {
    vi.mocked(captureGit).mockRejectedValue(new Error('git boom'))
    const git = harness()
    await expect(git.save()).rejects.toMatchObject({ code: 'git' })
    expect(git.fs.files.has(ABS_HANDOFF)).toBe(false)

    vi.mocked(captureGit).mockResolvedValue(gitSnapshot())
    const model = harness({ stream: errorFinishStream() })
    await expect(model.save()).rejects.toMatchObject({ code: 'model' })
    expect(model.fs.files.has(ABS_HANDOFF)).toBe(false)

    const oversized = harness({ config: { maxDocumentBytes: 16 } })
    await expect(oversized.save()).rejects.toMatchObject({ code: 'document' })
    expect(oversized.fs.files.has(ABS_HANDOFF)).toBe(false)
  })

  it('redacts fake secrets in git filenames and keeps them out of the document', async () => {
    vi.mocked(captureGit).mockResolvedValue(gitSnapshot({ changedFiles: [' M src/npm_FAKE_1234567890.ts'] }))
    const h = harness()
    const result = await h.save()
    const written = h.fs.files.get(ABS_HANDOFF)
    expect(written).toBeDefined()
    expect(written).not.toContain('npm_FAKE_1234567890')
    expect(written).toContain('<redacted:npm-token>')
    expect(result.redactionCount).toBe(1)
  })

  it('sums redaction counts across input, output, and git filenames', async () => {
    const session = makeSeededSession('instruction npm_FAKE_1234567890')
    const event = session.events.find((candidate) => candidate.type === 'user/message') as unknown as SurfaceEvent
    vi.mocked(captureGit).mockResolvedValue(gitSnapshot({ changedFiles: [' M src/npm_FAKE_1234567890.ts'] }))
    const h = harness({
      session,
      surfaceEvents: [event],
      stream: async function* () {
        for (const chunk of successChunks(summaryMarkdown(['npm_FAKE_1234567890', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']))) {
          yield chunk
        }
      },
    })
    const result = await h.save()
    expect(result.redactionCount).toBe(3)
  })
})
