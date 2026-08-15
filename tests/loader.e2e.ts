import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandService from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmService, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)

// The built bundle is the module under test: the Loader resolves the handoff
// plugin from lib/index.js, never from src.
const HANDOFF_ENTRY = fileURLToPath(new URL('../lib/index.js', import.meta.url))

const ROWS = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
  "- name: '@deepseek-ai/dsh-agent-loop'",
  '  config:',
  '    agents: []',
  "- name: '@deepseek-ai/dsh-commands'",
  "- name: '@deepseek-ai/dsh-session-query-sqlite'",
  '  config:',
  "    path: ':memory:'",
  "- name: '@deepseek-ai/dsh-fs-local'",
  "- name: '@deepseek-ai/dsh-subprocess-local'",
  "- name: '@test/scripted-adapter'",
  "- name: '@dsh-external/dsh-handoff'",
  '  config:',
  '    summarizationProvider: scripted',
  '    summarizationModel: scripted',
]

const SOURCE_TURN = 'Build the handoff feature'
const CONTINUATION = 'Continue from the handoff'

// The summarization response must carry all nine required headings in order and
// the exact facts the document assertion relies on.
const SUMMARY = [
  '## Objective',
  'Implement handoff',
  '## User Requirements and Decisions',
  'Save and load the development handoff',
  '## Completed Work',
  'Implemented save, redaction, and load',
  '## Current State',
  'Task 8 in progress',
  '## Validation',
  'pnpm test',
  '## Failed Attempts and Warnings',
  'none',
  '## Remaining Work',
  'Run the next planned task',
  '## Recommended Next Action',
  'Run Task 9',
  '## Critical References',
  'src/index.ts',
].join('\n')

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: string[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.responses.shift()
    if (text === undefined) throw new Error('ScriptedAdapter: script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let loaded: Context | undefined
let repoRoot: string | undefined
let configRoot: string | undefined

afterEach(async () => {
  await loaded?.fiber.dispose()
  loaded = undefined
  if (configRoot !== undefined) await rm(configRoot, { recursive: true, force: true })
  configRoot = undefined
  if (repoRoot !== undefined) await rm(repoRoot, { recursive: true, force: true })
  repoRoot = undefined
})

/**
 * Replace only generated time, session ids, the temporary repository root, Git
 * HEAD, and SHA-256 digests with named tokens. Headings, command text, source
 * form, file names, event types, and ordering stay verbatim.
 */
function normalizeSnapshot(line: string, root: string): string {
  let out = line.replaceAll(root, '<REPO_ROOT>')
  out = out.replaceAll('loader-source', '<SOURCE_SESSION_ID>')
  out = out.replaceAll('loader-fresh', '<FRESH_SESSION_ID>')
  out = out.replaceAll('loader-stale', '<STALE_SESSION_ID>')
  out = out.replace(/\b[0-9a-f]{64}\b/g, '<SHA256>')
  out = out.replace(/\b[0-9a-f]{40}\b/g, '<GIT_HEAD>')
  out = out.replace(/20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<GENERATED_AT>')
  return out
}

async function loadComposition(adapter: ScriptedAdapter): Promise<Context> {
  const configPath = join(configRoot!, 'cordis.yml')
  await writeFile(configPath, [...ROWS, ''].join('\n'))

  const ctx = new Context()
  loaded = ctx
  ctx.baseUrl = pathToFileURL(configRoot!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  const handoff = await import(pathToFileURL(HANDOFF_ENTRY).href)
  const scriptedAdapter = {
    name: 'scripted-adapter',
    inject: ['llm'],
    apply(inner: Context): () => void {
      return inner.llm.registerAdapter(['scripted'], adapter)
    },
  }

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmService],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandService],
    ['@deepseek-ai/dsh-session-query-sqlite', SessionQuerySqlite],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessService],
    ['@test/scripted-adapter', scriptedAdapter],
    ['@dsh-external/dsh-handoff', handoff],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string): Promise<unknown> {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('real Loader composition', () => {
  it('proves handoff save/load through the shipping Loader and AgentLoop', { timeout: 60_000 }, async () => {
    // 1. A temporary Git repository with one committed file.
    const repoDir = await mkdtemp(join(tmpdir(), 'dsh-handoff-e2e-repo-'))
    // On macOS `tmpdir()` sits under `/var`, a symlink to `/private/var`; git
    // reports the canonical root, so canonicalize the directory before use.
    repoRoot = await realpath(repoDir)
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src', 'index.ts'), 'export const value = 1\n')
    await execFileAsync('git', ['add', 'src/index.ts'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })

    // 2. Compose the real services and the handoff plugin through the Loader.
    configRoot = await mkdtemp(join(tmpdir(), 'dsh-handoff-e2e-config-'))
    const adapter = new ScriptedAdapter(['Source turn complete.', SUMMARY, 'Continuation complete.'])
    const ctx = await loadComposition(adapter)
    expect(ctx.agents).toBeInstanceOf(AgentRegistry)
    expect(ctx.agentLoop).toBeInstanceOf(AgentLoop)
    expect(ctx.commands).toBeInstanceOf(CommandService)

    const signal = new AbortController()

    // 3. Source agent: one turn, then save without mutating its model surface.
    const sourceAgent = ctx.agentLoop.create(
      SessionId('loader-source'),
      { provider: 'scripted', model: 'scripted' },
      { cwd: repoRoot },
    )
    sourceAgent.followup(createUserMessage({ content: [{ type: 'text', text: SOURCE_TURN }], source: { kind: 'user' } }))
    await sourceAgent.whenIdle()

    const surfaceBefore = sourceAgent.session.deriveMessages()
    const saveExec = await ctx.commands.execute(sourceAgent, '/handoff save', signal.signal)
    expect(saveExec).toBeDefined()
    expect(saveExec!.result).toEqual({
      kind: 'success',
      text: expect.stringMatching(/^Saved docs\/handoffs\/current\.md through session seq \d+ \(0 secrets redacted\)\.$/),
    })
    const surfaceAfter = sourceAgent.session.deriveMessages()
    expect(surfaceAfter).toEqual(surfaceBefore)

    const documentText = await readFile(join(repoRoot, 'docs', 'handoffs', 'current.md'), 'utf8')
    for (const fact of ['Implement handoff', 'src/index.ts', 'pnpm test', 'Run the next planned task']) {
      expect(documentText).toContain(fact)
    }
    expect(documentText).toContain('Format: dsh-handoff/v1')
    expect(documentText).toContain('## Changed Files\n(none)')
    expect(documentText).not.toContain(repoRoot)

    // 4. Fresh agent: load injects durable recall without waking it. The normal
    // (non-stale) result also proves the written handoff file is excluded from
    // the Git state digest — otherwise it would already read as stale.
    const freshAgent = ctx.agentLoop.create(
      SessionId('loader-fresh'),
      { provider: 'scripted', model: 'scripted' },
      { cwd: repoRoot },
    )
    const freshLoadExec = await ctx.commands.execute(freshAgent, '/handoff load', signal.signal)
    expect(freshLoadExec).toBeDefined()
    expect(freshLoadExec!.result).toEqual({
      kind: 'success',
      text: 'Loaded docs/handoffs/current.md. Send the next development instruction.',
    })
    expect(freshAgent.status).toBe('idle')
    expect(freshAgent.inbox.nextStep).toHaveLength(1)

    // 5. The next user turn admits the recall before the current instruction.
    freshAgent.followup(createUserMessage({ content: [{ type: 'text', text: CONTINUATION }], source: { kind: 'user' } }))
    await freshAgent.whenIdle()

    const freshUserEvents = freshAgent.session.events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message',
    )
    expect(freshUserEvents).toHaveLength(2)
    const recallSource = freshUserEvents[0]!.data.source
    expect(recallSource).toEqual({ kind: 'plugin', plugin: 'dsh-handoff', form: 'recall' })
    expect(freshUserEvents[1]!.data.source).toEqual({ kind: 'user' })

    expect(adapter.requests).toHaveLength(3)
    const thirdRequest = adapter.requests[2]!
    const thirdUserMessages = thirdRequest.messages.filter((message) => message.role === 'user')
    expect(thirdUserMessages).toHaveLength(2)
    expect(thirdUserMessages[0]!.source).toEqual({ kind: 'plugin', plugin: 'dsh-handoff', form: 'recall' })
    expect(thirdUserMessages[1]!.source).toEqual({ kind: 'user' })

    // 6. Stale branch: a non-handoff change warns but still injects.
    await writeFile(join(repoRoot, 'src', 'index.ts'), 'export const value = 2\n')
    const staleAgent = ctx.agentLoop.create(
      SessionId('loader-stale'),
      { provider: 'scripted', model: 'scripted' },
      { cwd: repoRoot },
    )
    const staleLoadExec = await ctx.commands.execute(staleAgent, '/handoff load', signal.signal)
    expect(staleLoadExec).toBeDefined()
    expect(staleLoadExec!.result).toEqual({
      kind: 'success',
      text: 'Loaded docs/handoffs/current.md with a repository-state warning; current files take precedence. Send the next development instruction.',
    })
    expect(staleAgent.status).toBe('idle')
    expect(staleAgent.inbox.nextStep).toHaveLength(1)

    // 7. Keyless inline snapshot: normalize only generated time, session ids,
    // the repository root, Git HEAD, and SHA-256 digests; keep command text,
    // headings, source form, event types, and ordering verbatim.
    const freshUserSources = freshUserEvents.map((event) => event.data.source)
    const thirdUserSources = thirdUserMessages.map((message) => message.source)
    const observation = [
      `save result: ${saveExec!.result.kind} ${saveExec!.result.text}`,
      `save preserves source surface: ${JSON.stringify(surfaceAfter) === JSON.stringify(surfaceBefore)}`,
      '',
      '--- handoff document ---',
      ...documentText.trimEnd().split('\n'),
      '--- fresh load ---',
      `fresh load result: ${freshLoadExec!.result.text}`,
      `fresh agent idle after load: ${freshAgent.status === 'idle'}`,
      `recall source: ${JSON.stringify(recallSource)}`,
      `admitted user/message order: ${freshUserSources.map((source) => JSON.stringify(source)).join(' then ')}`,
      `model request user order: ${thirdUserSources.map((source) => JSON.stringify(source)).join(' then ')}`,
      '',
      '--- stale load ---',
      `stale load result: ${staleLoadExec!.result.text}`,
      `stale agent idle after load: ${staleAgent.status === 'idle'}`,
    ]
    expect(observation.map((line) => normalizeSnapshot(line, repoRoot!))).toMatchInlineSnapshot(`
      [
        "save result: success Saved docs/handoffs/current.md through session seq 14 (0 secrets redacted).",
        "save preserves source surface: true",
        "",
        "--- handoff document ---",
        "# DSH Handoff",
        "",
        "Format: dsh-handoff/v1",
        "Generated: <GENERATED_AT>",
        "Source session: <SOURCE_SESSION_ID>",
        "Captured through seq: 14",
        "Workspace: .",
        "Git branch: main",
        "Git HEAD: <GIT_HEAD>",
        "Git state digest: <SHA256>",
        "",
        "## Objective",
        "Implement handoff",
        "",
        "## User Requirements and Decisions",
        "Save and load the development handoff",
        "",
        "## Completed Work",
        "Implemented save, redaction, and load",
        "",
        "## Current State",
        "Task 8 in progress",
        "",
        "## Changed Files",
        "(none)",
        "",
        "## Validation",
        "pnpm test",
        "",
        "## Failed Attempts and Warnings",
        "none",
        "",
        "## Remaining Work",
        "Run the next planned task",
        "",
        "## Recommended Next Action",
        "Run Task 9",
        "",
        "## Critical References",
        "src/index.ts",
        "",
        "## Redaction Warnings",
        "(none)",
        "--- fresh load ---",
        "fresh load result: Loaded docs/handoffs/current.md. Send the next development instruction.",
        "fresh agent idle after load: true",
        "recall source: {"kind":"plugin","plugin":"dsh-handoff","form":"recall"}",
        "admitted user/message order: {"kind":"plugin","plugin":"dsh-handoff","form":"recall"} then {"kind":"user"}",
        "model request user order: {"kind":"plugin","plugin":"dsh-handoff","form":"recall"} then {"kind":"user"}",
        "",
        "--- stale load ---",
        "stale load result: Loaded docs/handoffs/current.md with a repository-state warning; current files take precedence. Send the next development instruction.",
        "stale agent idle after load: true",
      ]
    `)

    // 8. Disposal: unloading the handoff entry removes the command.
    const handoffEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === '@dsh-external/dsh-handoff')
    expect(handoffEntry).toBeDefined()
    expect(handoffEntry!.fiber).toBeDefined()
    expect(ctx.commands.find(staleAgent, 'handoff')).toBeDefined()
    await handoffEntry!.fiber!.dispose()
    expect(ctx.commands.find(staleAgent, 'handoff')).toBeUndefined()
  })
})
