import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { HandoffError } from './error.ts'

// The one runtime document path. It is a constant, not configuration, so the
// save and load sides always agree on a single repository source of truth.
export const HANDOFF_PATH = 'docs/handoffs/current.md' as const

function classifyFsError(error: unknown, message: string): HandoffError {
  if (error instanceof FsError) {
    if (error.code === 'FS_ABORTED') return new HandoffError('cancelled', 'filesystem operation was cancelled')
    return new HandoffError('filesystem', message, { cause: error })
  }
  throw error
}

async function fsCall<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw classifyFsError(error, message)
  }
}

export async function resolveHandoffTarget(fs: FileSystem, root: string, signal: AbortSignal): Promise<FsTarget> {
  const linkInfo = await fsCall(() => fs.lstat(HANDOFF_PATH, { cwd: root }, signal), 'handoff path is not accessible')
  if (linkInfo !== undefined && linkInfo.type === 'symlink') {
    throw new HandoffError('filesystem', 'handoff path must not be a symbolic link')
  }
  const rootTarget = await fsCall(() => fs.resolve(root, { signal }), 'handoff path is not accessible')
  const target = await fsCall(() => fs.resolve(HANDOFF_PATH, { cwd: root, signal }), 'handoff path is not accessible')
  if (!fs.contains(rootTarget, target)) {
    throw new HandoffError('filesystem', 'handoff path must stay inside the repository')
  }
  const info = await fsCall(() => fs.stat(target, signal), 'handoff path is not accessible')
  if (info !== undefined && info.type !== 'file') {
    throw new HandoffError('filesystem', 'handoff path must be a regular file')
  }
  return target
}

export async function readHandoffText(
  fs: FileSystem,
  root: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; version: FsVersion }> {
  const target = await resolveHandoffTarget(fs, root, signal)
  const info = await fsCall(() => fs.stat(target, signal), 'handoff document is not accessible')
  if (info === undefined) throw new HandoffError('filesystem', 'handoff document does not exist')
  const bytes = await fsCall(() => fs.readBytes(target, signal, maxBytes), 'failed to read the handoff document')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new HandoffError('filesystem', 'handoff document is not valid UTF-8')
  }
  return { text, version: info.version }
}

export async function writeHandoffText(fs: FileSystem, root: string, text: string, signal: AbortSignal): Promise<void> {
  const target = await resolveHandoffTarget(fs, root, signal)
  const info = await fsCall(() => fs.stat(target, signal), 'failed to write the handoff document')
  const intent: FsWriteIntent =
    info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }
  await fsCall(() => fs.writeText(target, text, intent, signal), 'failed to write the handoff document')
}
