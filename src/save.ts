import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
// Empty type import: applies the package's `declare module '@deepseek-ai/cordis'`
// augmentation so `Context.sessionQuery` is visible in the production build
// graph (tsconfig.build.json compiles `src` only).
import type {} from '@deepseek-ai/dsh-session-query'
import { captureGit } from './git.ts'
import { summarizeHandoff } from './summarize.ts'
import { mergeRedactionCounts, redactText } from './redact.ts'
import { handoffDigest, renderHandoffDocument } from './document.ts'
import { HANDOFF_PATH, writeHandoffText } from './storage.ts'
import { HandoffError } from './error.ts'
import type { GitSnapshot, HandoffMetadata, RedactionCounts, ResolvedHandoffConfig, SummarySections } from './types.ts'

export interface SaveResult {
  readonly path: 'docs/handoffs/current.md'
  readonly capturedThroughSeq: number | null
  readonly digest: string
  readonly redactionCount: number
}

export interface SaveOptions {
  readonly env: NodeJS.ProcessEnv
  readonly now: () => Date
}

async function saveTransaction(
  ctx: Context,
  agent: Agent,
  config: ResolvedHandoffConfig,
  signal: AbortSignal,
  options: SaveOptions,
): Promise<SaveResult> {
  if (signal.aborted) throw new HandoffError('cancelled', 'save was cancelled')

  const surface = await ctx.sessionQuery.readSurface(agent.id)
  const messages = surface.events.flatMap((event) => {
    const message = deriveEventMessage(event)
    return message === null ? [] : [message]
  })

  let git: GitSnapshot
  try {
    git = await captureGit(ctx.subprocess, agent.session.header.cwd ?? process.cwd(), signal, config.gitTimeoutMs)
  } catch (error) {
    if (signal.aborted) throw new HandoffError('cancelled', 'save was cancelled', { cause: error })
    throw new HandoffError('git', 'failed to capture git state', { cause: error })
  }

  let summarized: { summary: SummarySections; redactions: RedactionCounts }
  try {
    summarized = await summarizeHandoff(ctx.llm.stream.bind(ctx.llm), {
      agent,
      messages,
      config,
      env: options.env,
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new HandoffError('cancelled', 'save was cancelled', { cause: error })
    throw new HandoffError('model', 'failed to summarize the session', { cause: error })
  }

  const changed = git.changedFiles.map((file) => redactText(file, options.env))
  const changedFiles = changed.map((result) => result.text)
  const workspace = redactText(git.relativeCwd, options.env)
  const branch = redactText(git.branch, options.env)
  const gitCounts = mergeRedactionCounts(
    ...changed.map((result) => result.counts),
    workspace.counts,
    branch.counts,
  )
  const redactionCounts: Readonly<RedactionCounts> = mergeRedactionCounts(summarized.redactions, gitCounts)

  const metadata: HandoffMetadata = {
    generated: options.now().toISOString(),
    sourceSession: String(agent.id),
    capturedThroughSeq: surface.capturedThroughSeq,
    workspace: workspace.text,
    gitBranch: branch.text,
    gitHead: git.head,
    gitStateDigest: git.stateDigest,
  }

  const text = renderHandoffDocument({
    metadata,
    summary: summarized.summary,
    changedFiles,
    redactions: redactionCounts,
  })

  if (Buffer.byteLength(text, 'utf8') > config.maxDocumentBytes) {
    throw new HandoffError('document', 'handoff document exceeds the configured byte limit')
  }

  await writeHandoffText(ctx.fs, git.root, text, signal)

  const redactionCount = Object.values(redactionCounts).reduce((sum, count) => sum + (count ?? 0), 0)
  return {
    path: HANDOFF_PATH,
    capturedThroughSeq: surface.capturedThroughSeq,
    digest: handoffDigest(text),
    redactionCount,
  }
}

export async function saveHandoff(
  ctx: Context,
  agent: Agent,
  config: ResolvedHandoffConfig,
  signal: AbortSignal | undefined,
  options: SaveOptions,
): Promise<SaveResult> {
  if (signal?.aborted === true) throw new HandoffError('cancelled', 'save was cancelled')
  let maintenance: Promise<SaveResult>
  try {
    maintenance = agent.runMaintenance(async (maintenanceSignal) => {
      const combined = signal === undefined ? maintenanceSignal : AbortSignal.any([signal, maintenanceSignal])
      return saveTransaction(ctx, agent, config, combined, options)
    })
  } catch {
    throw new HandoffError('busy', 'agent is already running a turn or maintenance task')
  }
  return maintenance
}
