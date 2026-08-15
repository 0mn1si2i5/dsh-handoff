import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { summarizeHandoff } from '../src/summarize.ts'
import type { SummarizeRequest } from '../src/summarize.ts'
import type { ResolvedHandoffConfig, SummarySections } from '../src/types.ts'

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

const EXPECTED_INSTRUCTION = `You are producing a compact engineering handoff for a fresh DeepSeek Harness session. Summarize only the conversation above. Preserve user decisions, exact paths, commands, errors, validation results, unfinished work, and one concrete next action.

Output exactly these headings in order. Use terse bullets. Write \`(none)\` for an empty section. Output no preamble and call no tools.

## Objective
## User Requirements and Decisions
## Completed Work
## Current State
## Validation
## Failed Attempts and Warnings
## Remaining Work
## Recommended Next Action
## Critical References`

const baseConfig: ResolvedHandoffConfig = {
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 4096,
  maxDocumentBytes: 32768,
  gitTimeoutMs: 10000,
}

function summaryMarkdown(): string {
  return SUMMARY_HEADINGS.map((heading, index) => `## ${heading}\nbody-${index}`).join('\n\n')
}

const expectedSummary: SummarySections = {
  objective: 'body-0',
  userRequirementsAndDecisions: 'body-1',
  completedWork: 'body-2',
  currentState: 'body-3',
  validation: 'body-4',
  failedAttemptsAndWarnings: 'body-5',
  remainingWork: 'body-6',
  recommendedNextAction: 'body-7',
  criticalReferences: 'body-8',
}

function fakeAgent(
  options: { provider?: string; model?: string } = { provider: 'default-provider', model: 'default-model' },
  header?: { provider: string; model: string },
): Agent {
  return {
    options,
    session: {
      id: 'test-session',
      requestHeader: () => (header === undefined ? undefined : { config: header }),
    },
  } as unknown as Agent
}

function makeRequest(overrides: {
  agent?: Agent
  messages?: readonly Message[]
  config?: ResolvedHandoffConfig
  env?: NodeJS.ProcessEnv
} = {}): SummarizeRequest {
  return {
    agent: overrides.agent ?? fakeAgent(),
    messages: overrides.messages ?? [],
    config: overrides.config ?? { ...baseConfig },
    env: overrides.env ?? {},
  }
}

function successChunks(): StreamChunk[] {
  const text = summaryMarkdown()
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function spyStream(chunks: StreamChunk[]): { stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls.push(options)
    for (const chunk of chunks) yield chunk
  }
  return { stream, calls }
}

describe('summarizeHandoff', () => {
  it('uses the explicit provider/model override', async () => {
    const { stream, calls } = spyStream(successChunks())
    const config = { ...baseConfig, summarizationProvider: 'explicit-provider', summarizationModel: 'explicit-model' }
    const agent = fakeAgent({ provider: 'agent-provider', model: 'agent-model' }, { provider: 'header-provider', model: 'header-model' })
    await summarizeHandoff(stream, makeRequest({ agent, config }))
    expect(calls[0]!.provider).toBe('explicit-provider')
    expect(calls[0]!.model).toBe('explicit-model')
  })

  it('prefers the session request header over agent options', async () => {
    const { stream, calls } = spyStream(successChunks())
    const agent = fakeAgent({ provider: 'agent-provider', model: 'agent-model' }, { provider: 'header-provider', model: 'header-model' })
    await summarizeHandoff(stream, makeRequest({ agent }))
    expect(calls[0]!.provider).toBe('header-provider')
    expect(calls[0]!.model).toBe('header-model')
  })

  it('falls back to agent options when no header exists', async () => {
    const { stream, calls } = spyStream(successChunks())
    const agent = fakeAgent({ provider: 'agent-provider', model: 'agent-model' })
    await summarizeHandoff(stream, makeRequest({ agent }))
    expect(calls[0]!.provider).toBe('agent-provider')
    expect(calls[0]!.model).toBe('agent-model')
  })

  it('rejects before calling stream when no complete route exists', async () => {
    const { stream, calls } = spyStream(successChunks())
    const agent = fakeAgent({ provider: 'agent-provider' })
    await expect(summarizeHandoff(stream, makeRequest({ agent }))).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('redacts message text before it reaches the stream', async () => {
    const { stream, calls } = spyStream(successChunks())
    const message = createUserMessage({
      content: [{ type: 'text', text: 'npm_FAKE_1234567890 keep this' }],
      source: { kind: 'user' },
    })
    await summarizeHandoff(stream, makeRequest({ messages: [message] }))
    const serialized = JSON.stringify(calls[0])
    expect(serialized).not.toContain('npm_FAKE_1234567890')
    expect(serialized).toContain('<redacted:npm-token>')
  })

  it('appends the fixed instruction as a plugin user message', async () => {
    const { stream, calls } = spyStream(successChunks())
    await summarizeHandoff(stream, makeRequest())
    const sent = calls[0]!
    const last = sent.messages[sent.messages.length - 1]!
    expect(last.role).toBe('user')
    expect(last.source).toEqual({ kind: 'plugin', plugin: 'dsh-handoff' })
    expect(last.content[0]).toEqual({ type: 'text', text: EXPECTED_INSTRUCTION })
  })

  it('sends only the current messages and never filesystem-derived text', async () => {
    const { stream, calls } = spyStream(successChunks())
    const message = createUserMessage({
      content: [{ type: 'text', text: 'current session instruction' }],
      source: { kind: 'user' },
    })
    await summarizeHandoff(stream, makeRequest({ messages: [message] }))
    const sent = calls[0]!
    expect(sent.messages).toHaveLength(2)
    expect(JSON.stringify(sent.messages)).not.toContain('Changed Files')
    expect(JSON.stringify(sent.messages)).not.toContain(' M src/index.ts')
  })

  it('forwards maxTokens and sessionId without tools, system, or purpose', async () => {
    const { stream, calls } = spyStream(successChunks())
    const config = { ...baseConfig, maxTokens: 1234 }
    await summarizeHandoff(stream, makeRequest({ config }))
    const sent = calls[0]!
    expect(sent.maxTokens).toBe(1234)
    expect(sent.sessionId).toBe('test-session')
    expect('tools' in sent).toBe(false)
    expect('system' in sent).toBe(false)
    expect('purpose' in sent).toBe(false)
  })

  it('parses all nine summary sections from text chunks', async () => {
    const { stream } = spyStream(successChunks())
    const result = await summarizeHandoff(stream, makeRequest())
    expect(result.summary).toEqual(expectedSummary)
  })

  it('ignores reasoning blocks', async () => {
    const text = summaryMarkdown()
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking out loud' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking out loud' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text },
      { type: 'block-end', index: 1, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { stream } = spyStream(chunks)
    const result = await summarizeHandoff(stream, makeRequest())
    expect(result.summary).toEqual(expectedSummary)
  })

  it('rejects image blocks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-end', index: 0, block: { type: 'image', attachment: {} } } as unknown as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { stream } = spyStream(chunks)
    await expect(summarizeHandoff(stream, makeRequest())).rejects.toThrow()
  })

  it('rejects tool-call blocks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'tool-call-delta', index: 0, id: CallId('call-0'), name: 'run', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { stream } = spyStream(chunks)
    await expect(summarizeHandoff(stream, makeRequest())).rejects.toThrow()
  })

  it.each([
    ['max-tokens', { type: 'finish', reason: { kind: 'max-tokens' } } as StreamChunk],
    ['error', { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'ERR' } } } as StreamChunk],
    ['aborted', { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } } as StreamChunk],
  ])('rejects a %s finish', async (_label, finishChunk) => {
    const { stream } = spyStream([finishChunk])
    await expect(summarizeHandoff(stream, makeRequest())).rejects.toThrow()
  })

  it('rejects a stream that ends without a finish', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: summaryMarkdown() },
      { type: 'block-end', index: 0, block: { type: 'text', text: summaryMarkdown() } },
    ]
    const { stream } = spyStream(chunks)
    await expect(summarizeHandoff(stream, makeRequest())).rejects.toThrow()
  })

  it('rejects empty output', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { stream } = spyStream(chunks)
    await expect(summarizeHandoff(stream, makeRequest())).rejects.toThrow()
  })
})
