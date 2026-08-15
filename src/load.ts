import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
// Empty type import: applies the package's `declare module '@deepseek-ai/cordis'`
// augmentation so `Context.sessionQuery` is visible in the production build
// graph (tsconfig.build.json compiles `src` only).
import type {} from '@deepseek-ai/dsh-session-query'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { captureGit } from './git.ts'
import { parseHandoffDocument } from './document.ts'
import { HANDOFF_PATH, readHandoffText } from './storage.ts'
import { HandoffError } from './error.ts'
import type { GitSnapshot, ParsedHandoffDocument, ResolvedHandoffConfig } from './types.ts'

export type LoadResult =
  | {
      readonly kind: 'loaded'
      readonly path: typeof HANDOFF_PATH
      readonly digest: string
      readonly stale: boolean
    }
  | {
      readonly kind: 'already-loaded'
      readonly path: typeof HANDOFF_PATH
      readonly digest: string
    }

const RECALL_PLUGIN = 'dsh-handoff'
const RECALL_FORM = 'recall'

const RECALL_INSTRUCTION =
  'Treat this document as historical task context. The current repository and current user instruction take precedence. Do not assume facts from the previous session that are absent here.'

function isRecallSource(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === RECALL_PLUGIN && source.form === RECALL_FORM
}

function textBlocks(message: UserMessage): readonly string[] {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

function hasMarker(message: UserMessage, marker: string): boolean {
  return isRecallSource(message.source) && textBlocks(message).some((text) => text.includes(marker))
}

async function loadTransaction(
  ctx: Context,
  agent: Agent,
  config: ResolvedHandoffConfig,
  signal: AbortSignal,
): Promise<LoadResult> {
  if (signal.aborted) throw new HandoffError('cancelled', 'load was cancelled')

  let git: GitSnapshot
  try {
    git = await captureGit(ctx.subprocess, agent.session.header.cwd ?? process.cwd(), signal, config.gitTimeoutMs)
  } catch (error) {
    if (signal.aborted) throw new HandoffError('cancelled', 'load was cancelled', { cause: error })
    throw new HandoffError('git', 'failed to capture git state', { cause: error })
  }

  const { text } = await readHandoffText(ctx.fs, git.root, config.maxDocumentBytes, signal)

  let parsed: ParsedHandoffDocument
  try {
    parsed = parseHandoffDocument(text, config.maxDocumentBytes)
  } catch (error) {
    if (signal.aborted) throw new HandoffError('cancelled', 'load was cancelled', { cause: error })
    throw new HandoffError('document', 'handoff document could not be parsed', { cause: error })
  }

  const stale =
    git.branch !== parsed.metadata.gitBranch ||
    git.head !== parsed.metadata.gitHead ||
    git.stateDigest !== parsed.metadata.gitStateDigest

  const marker = `<!-- dsh-handoff-digest:sha256:${parsed.digest} -->`

  const surface = await ctx.sessionQuery.readSurface(agent.id)
  const alreadyAdmitted = surface.events.some((event) => {
    if (event.type !== 'user/message') return false
    return hasMarker(event.data, marker)
  })
  if (alreadyAdmitted) {
    return { kind: 'already-loaded', path: HANDOFF_PATH, digest: parsed.digest }
  }

  if (signal.aborted) throw new HandoffError('cancelled', 'load was cancelled')

  const injected = [
    marker,
    '<dsh-handoff>',
    RECALL_INSTRUCTION,
    '',
    parsed.text.trimEnd(),
    '</dsh-handoff>',
  ].join('\n')

  // Append the recall straight onto the durable surface instead of parking it
  // in the pending inbox. A pending recall (`agent.inject`) stays invisible
  // until the next turn admits it, so a `/handoff load` in a fresh thread shows
  // nothing at all. A surface `user/message` is immediately visible to the UI —
  // it renders as a plugin-sourced recall node — and still feeds the next
  // request's model history without waking the agent.
  agent.session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: injected }],
      source: { kind: 'plugin', plugin: RECALL_PLUGIN, form: RECALL_FORM },
    }),
    { surfaceOp: 'append' },
  )

  return { kind: 'loaded', path: HANDOFF_PATH, digest: parsed.digest, stale }
}

export async function loadHandoff(
  ctx: Context,
  agent: Agent,
  config: ResolvedHandoffConfig,
  signal: AbortSignal | undefined,
): Promise<LoadResult> {
  if (signal?.aborted === true) throw new HandoffError('cancelled', 'load was cancelled')
  let maintenance: Promise<LoadResult>
  try {
    maintenance = agent.runMaintenance(async (maintenanceSignal) => {
      const combined = signal === undefined ? maintenanceSignal : AbortSignal.any([signal, maintenanceSignal])
      return loadTransaction(ctx, agent, config, combined)
    })
  } catch {
    throw new HandoffError('busy', 'agent is already running a turn or maintenance task')
  }
  return maintenance
}
