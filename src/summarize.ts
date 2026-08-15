import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseSummaryMarkdown } from './document.ts'
import { mergeRedactionCounts, redactMessages, redactText } from './redact.ts'
import type { RedactionCounts, ResolvedHandoffConfig, SummarySections } from './types.ts'

// Fixed, verbatim instruction appended as the final user message. The model is
// asked to summarize only the conversation above: no Git status, changed files,
// or other filesystem-derived text may enter the request.
const SUMMARY_INSTRUCTION = `You are producing a compact engineering handoff for a fresh DeepSeek Harness session. Summarize only the conversation above. Preserve user decisions, exact paths, commands, errors, validation results, unfinished work, and one concrete next action.

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

export interface SummarizeRequest {
  readonly agent: Agent
  readonly messages: readonly Message[]
  readonly config: ResolvedHandoffConfig
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

export type SummarizeStream = (options: GenerateOptions) => AsyncIterable<StreamChunk>

interface Route {
  readonly provider: string
  readonly model: string
}

function resolveRoute(agent: Agent, config: ResolvedHandoffConfig): Route {
  if (config.summarizationProvider !== '' && config.summarizationModel !== '') {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const header = agent.session.requestHeader()?.config
  if (header !== undefined && header.provider !== '' && header.model !== '') {
    return { provider: header.provider, model: header.model }
  }
  const options = agent.options
  if (options.provider !== undefined && options.provider !== '' && options.model !== undefined && options.model !== '') {
    return { provider: options.provider, model: options.model }
  }
  throw new Error('no complete provider/model route for summarization')
}

export async function summarizeHandoff(
  stream: SummarizeStream,
  request: SummarizeRequest,
): Promise<{ summary: SummarySections; redactions: RedactionCounts }> {
  request.signal?.throwIfAborted()
  const route = resolveRoute(request.agent, request.config)

  const redacted = redactMessages(request.messages, request.env)
  const instruction = createUserMessage({
    content: [{ type: 'text', text: SUMMARY_INSTRUCTION }],
    source: { kind: 'plugin', plugin: 'dsh-handoff' },
  })

  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [...redacted.value, instruction],
    maxTokens: request.config.maxTokens,
    sessionId: request.agent.session.id,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }

  const assembler = new BlockAssembler()
  let sawFinish = false
  for await (const chunk of stream(options)) {
    if (chunk.type === 'finish') sawFinish = true
    assembler.push(chunk)
  }

  if (!sawFinish) throw new Error('summary stream ended without a finish')
  if (assembler.finish.kind !== 'stop') throw new Error('summary stream did not finish successfully')

  const parts: string[] = []
  for (const block of assembler.blocks()) {
    if (block.type === 'text') {
      if (block.text.trim() !== '') parts.push(block.text)
    } else if (block.type === 'reasoning') {
      // Reasoning is model thinking, not visible output; ignore it.
    } else {
      throw new Error('summary produced a non-text block')
    }
  }
  const text = parts.join('\n')
  if (text.trim() === '') throw new Error('summary produced no text')

  const output = redactText(text, request.env)
  const summary = parseSummaryMarkdown(output.text)
  const inputCounts: RedactionCounts = { ...redacted.counts }
  const outputCounts: RedactionCounts = { ...output.counts }
  return { summary, redactions: { ...mergeRedactionCounts(inputCounts, outputCounts) } }
}
