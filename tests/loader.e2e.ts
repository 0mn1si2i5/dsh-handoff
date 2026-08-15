import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
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

const RECALL_INSTRUCTION =
  'Treat this document as historical task context. The current repository and current user instruction take precedence. Do not assume facts from the previous session that are absent here.'

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

  get remainingResponses(): number {
    return this.responses.length
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

interface AdapterRegistration {
  registered: boolean
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

/** Concatenate only the text blocks of one message's content. */
function textContent(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

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

async function loadComposition(adapter: ScriptedAdapter): Promise<{ ctx: Context; registration: AdapterRegistration }> {
  const configPath = join(configRoot!, 'cordis.yml')
  await writeFile(configPath, [...ROWS, ''].join('\n'))

  const ctx = new Context()
  loaded = ctx
  ctx.baseUrl = pathToFileURL(configRoot!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  const handoff = await import(pathToFileURL(HANDOFF_ENTRY).href)
  const registration: AdapterRegistration = { registered: false }
  const scriptedAdapter = {
    name: 'scripted-adapter',
    inject: ['llm'],
    apply(inner: Context): () => void {
      const release = inner.llm.registerAdapter(['scripted'], adapter)
      registration.registered = true
      return () => {
        release()
        registration.registered = false
      }
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
  return { ctx, registration }
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
    const adapter = new ScriptedAdapter([
      'Source turn complete.',
      SUMMARY,
      'Saved and confirmed.',
      'Loaded and ready.',
      'Continuation complete.',
      'Loaded and ready.',
    ])
    const { ctx, registration } = await loadComposition(adapter)
    expect(ctx.agents).toBeInstanceOf(AgentRegistry)
    expect(ctx.agentLoop).toBeInstanceOf(AgentLoop)
    expect(ctx.commands).toBeInstanceOf(CommandService)
    expect(registration.registered).toBe(true)

    const signal = new AbortController()

    // 3. Source agent: one turn, then save. The save also wakes the model once
    // to acknowledge the result, so wait for that turn before reading further.
    const sourceAgent = ctx.agentLoop.create(
      SessionId('loader-source'),
      { provider: 'scripted', model: 'scripted' },
      { cwd: repoRoot },
    )
    sourceAgent.followup(createUserMessage({ content: [{ type: 'text', text: SOURCE_TURN }], source: { kind: 'user' } }))
    await sourceAgent.whenIdle()

    const saveExec = await ctx.commands.execute(sourceAgent, '/handoff save', signal.signal)
    expect(saveExec).toBeDefined()
    expect(saveExec!.result).toEqual({
      kind: 'success',
      text: expect.stringMatching(/^Saved docs\/handoffs\/current\.md through session seq \d+ \(0 secrets redacted\)\.$/),
    })
    await sourceAgent.whenIdle()
    const sourceAssistant = sourceAgent.session.events.filter(
      (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
    )
    expect(sourceAssistant).toHaveLength(2)
    const saveAcknowledged = textContent(sourceAssistant[1]!.data.message) === 'Saved and confirmed.'
    expect(saveAcknowledged).toBe(true)

    const documentText = await readFile(join(repoRoot, 'docs', 'handoffs', 'current.md'), 'utf8')
    // Recompute the digest independently so the exact injected text below is not
    // derived from the production helper under test.
    const digest = createHash('sha256').update(documentText, 'utf8').digest('hex')
    const expectedRecall = [
      `<!-- dsh-handoff-digest:sha256:${digest} -->`,
      '<dsh-handoff>',
      RECALL_INSTRUCTION,
      '',
      documentText.trimEnd(),
      '</dsh-handoff>',
    ].join('\n')
    for (const fact of ['Implement handoff', 'src/index.ts', 'pnpm test', 'Run the next planned task']) {
      expect(documentText).toContain(fact)
    }
    expect(documentText).toContain('Format: dsh-handoff/v1')
    expect(documentText).toContain('## Changed Files\n(none)')
    expect(documentText).not.toContain(repoRoot)
    const documentLines = documentText.trimEnd().split('\n')

    // 4. Fresh agent: load admits the recall onto the surface, then wakes the
    // model once to acknowledge — both visible in a brand-new thread. The
    // normal (non-stale) result also proves the written handoff file is
    // excluded from the Git state digest — otherwise it would already read as
    // stale.
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
    await freshAgent.whenIdle()

    const freshUserEvents = freshAgent.session.events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message',
    )
    expect(freshUserEvents).toHaveLength(2)
    expect(freshUserEvents[0]!.data.source).toEqual({ kind: 'plugin', plugin: 'dsh-handoff', form: 'recall' })
    const recallText = textContent(freshUserEvents[0]!.data)
    expect(recallText).toBe(expectedRecall)
    for (const fact of ['Implement handoff', 'src/index.ts', 'pnpm test', 'Run the next planned task']) {
      expect(recallText).toContain(fact)
    }
    expect(recallText).toContain('<dsh-handoff>')
    expect(recallText).toContain('</dsh-handoff>')
    expect(recallText).toContain(`<!-- dsh-handoff-digest:sha256:${digest} -->`)
    expect(freshUserEvents[1]!.data.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-handoff',
      form: 'notice',
      summary: 'Loaded docs/handoffs/current.md',
    })
    const surfaceRecallMatches = recallText === expectedRecall

    // 5. The user's next instruction lands after the recall and acknowledgment.
    freshAgent.followup(createUserMessage({ content: [{ type: 'text', text: CONTINUATION }], source: { kind: 'user' } }))
    await freshAgent.whenIdle()

    const freshUserSources = freshAgent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
      .map((event) => event.data.source)
    expect(freshUserSources).toHaveLength(3)

    // 6. The continuation request must see the full recall, the acknowledgment,
    // then the instruction.
    expect(adapter.requests).toHaveLength(5)
    for (const request of adapter.requests) {
      expect(request.provider).toBe('scripted')
      expect(request.model).toBe('scripted')
    }
    const continuationRequest = adapter.requests[4]!
    const continuationUserMessages = continuationRequest.messages.filter((message) => message.role === 'user')
    expect(continuationUserMessages).toHaveLength(3)
    expect(continuationUserMessages[0]!.source).toEqual({ kind: 'plugin', plugin: 'dsh-handoff', form: 'recall' })
    expect(textContent(continuationUserMessages[0]!)).toBe(expectedRecall)
    expect(continuationUserMessages[1]!.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-handoff', form: 'notice' })
    expect(continuationUserMessages[2]!.source).toEqual({ kind: 'user' })
    expect(textContent(continuationUserMessages[2]!)).toBe(CONTINUATION)
    const thirdUserSources = continuationUserMessages.map((message) => message.source)
    const thirdRecallMatches = textContent(continuationUserMessages[0]!) === expectedRecall
    const thirdInstruction = textContent(continuationUserMessages[2]!)

    // 7. Stale branch: a non-handoff change warns but still injects and
    // acknowledges.
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
    await staleAgent.whenIdle()
    const staleUserEvents = staleAgent.session.events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message',
    )
    expect(staleUserEvents).toHaveLength(2)
    const staleRecall = staleUserEvents[0]!.data
    expect(staleRecall.source).toEqual({ kind: 'plugin', plugin: 'dsh-handoff', form: 'recall' })
    expect(textContent(staleRecall)).toBe(expectedRecall)
    const staleRecallSource = staleRecall.source
    const staleRecallMatches = textContent(staleRecall) === expectedRecall

    // 8. Disposal: unloading the handoff entry removes the command, then the full
    // context disposal releases the scripted adapter registration.
    const handoffEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === '@dsh-external/dsh-handoff')
    expect(handoffEntry).toBeDefined()
    expect(handoffEntry!.fiber).toBeDefined()
    expect(ctx.commands.find(staleAgent, 'handoff')).toBeDefined()
    await handoffEntry!.fiber!.dispose()
    expect(ctx.commands.find(staleAgent, 'handoff')).toBeUndefined()
    expect(adapter.remainingResponses).toBe(0)
    await ctx.fiber.dispose()
    loaded = undefined
    expect(registration.registered).toBe(false)
    const adapterInactive = registration.registered === false
    const responsesExhausted = adapter.remainingResponses === 0

    // 9. Keyless inline snapshot: normalize only generated time, session ids,
    // the repository root, Git HEAD, and SHA-256 digests; keep command text,
    // headings, source form, event types, and ordering verbatim.
    const observation = [
      `save result: ${saveExec!.result.kind} ${saveExec!.result.text}`,
      `save acknowledges via model turn: ${saveAcknowledged}`,
      '',
      '--- handoff document ---',
      ...documentLines,
      '--- fresh load ---',
      `fresh load result: ${freshLoadExec!.result.text}`,
      `surface recall matches expectedRecall: ${surfaceRecallMatches}`,
      `fresh user/message order: ${freshUserSources.map((source) => JSON.stringify(source)).join(' then ')}`,
      `model request user order: ${thirdUserSources.map((source) => JSON.stringify(source)).join(' then ')}`,
      `model request recall matches expectedRecall: ${thirdRecallMatches}`,
      `model request current instruction: ${thirdInstruction}`,
      '',
      '--- stale load ---',
      `stale load result: ${staleLoadExec!.result.text}`,
      `stale recall source: ${JSON.stringify(staleRecallSource)}`,
      `stale recall matches expectedRecall: ${staleRecallMatches}`,
      '',
      '--- disposal ---',
      `adapter registration inactive after dispose: ${adapterInactive}`,
      `scripted responses exhausted: ${responsesExhausted}`,
    ]
    expect(observation.map((line) => normalizeSnapshot(line, repoRoot!))).toMatchInlineSnapshot(`
      [
        "save result: success Saved docs/handoffs/current.md through session seq 14 (0 secrets redacted).",
        "save acknowledges via model turn: true",
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
        "surface recall matches expectedRecall: true",
        "fresh user/message order: {"kind":"plugin","plugin":"dsh-handoff","form":"recall"} then {"kind":"plugin","plugin":"dsh-handoff","form":"notice","summary":"Loaded docs/handoffs/current.md"} then {"kind":"user"}",
        "model request user order: {"kind":"plugin","plugin":"dsh-handoff","form":"recall"} then {"kind":"plugin","plugin":"dsh-handoff","form":"notice","summary":"Loaded docs/handoffs/current.md"} then {"kind":"user"}",
        "model request recall matches expectedRecall: true",
        "model request current instruction: Continue from the handoff",
        "",
        "--- stale load ---",
        "stale load result: Loaded docs/handoffs/current.md with a repository-state warning; current files take precedence. Send the next development instruction.",
        "stale recall source: {"kind":"plugin","plugin":"dsh-handoff","form":"recall"}",
        "stale recall matches expectedRecall: true",
        "",
        "--- disposal ---",
        "adapter registration inactive after dispose: true",
        "scripted responses exhausted: true",
      ]
    `)
  })
})
