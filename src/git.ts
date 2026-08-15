import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessService,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { GitSnapshot } from './types.ts'

// Security/process invariants, not public configuration. The stdout cap keeps a
// pathological `status` listing bounded; the stderr cap bounds diagnostics; the
// grace bounds SIGTERM→SIGKILL escalation; the handoff path is the one runtime
// document excluded from every status listing.
const MAX_GIT_STDOUT_BYTES = 256 * 1024
const MAX_GIT_STDERR_BYTES = 64 * 1024
const GIT_TERMINATION_GRACE_MS = 1000
const HANDOFF_PATH = 'docs/handoffs/current.md'

// The only four Git operations the capture runs, as fixed argv (never a shell
// string). `status` uses NUL records and a pathspec that excludes the handoff
// document; the parser also drops that path defensively.
const ARGV_ROOT = ['rev-parse', '--show-toplevel'] as const
const ARGV_HEAD = ['rev-parse', 'HEAD'] as const
const ARGV_BRANCH = ['branch', '--show-current'] as const
const ARGV_STATUS = [
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
  '--',
  '.',
  ':(exclude)docs/handoffs/current.md',
] as const

const GIT_TIMEOUT_MESSAGE = 'git command timed out'

function readCollected(reader: SubprocessOutputReader | undefined): { text: string; lossy: boolean } {
  if (reader === undefined) return { text: '', lossy: false }
  const read = reader.readFrom(0)
  return { text: read.text, lossy: read.lossy }
}

/** Preserve caller cancellation, then classify a fired timeout separately. */
function rethrowAbort(signal: AbortSignal | undefined, timeout: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted()
  if (timeout.aborted) throw new Error(GIT_TIMEOUT_MESSAGE)
}

async function runGit(
  subprocess: SubprocessService,
  cwd: string,
  argv: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  if (signal?.aborted) signal.throwIfAborted()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error(GIT_TIMEOUT_MESSAGE)), timeoutMs)
  // A completed command must not hold the event loop open waiting on a leftover
  // timeout; a hung child still keeps the loop alive so the timer can fire.
  timer.unref()
  const combined = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])

  try {
    let executable: string
    try {
      executable = await subprocess.resolveExecutable('git', undefined, combined)
    } catch (error) {
      rethrowAbort(signal, timeout.signal)
      throw new Error('git failed to start', { cause: error })
    }
    rethrowAbort(signal, timeout.signal)

    let handle: SubprocessHandle
    try {
      const spec: SubprocessSpawnSpec = {
        argv: [executable, ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_GIT_STDOUT_BYTES },
          stderr: { maxBytes: MAX_GIT_STDERR_BYTES },
        },
        graceMs: GIT_TERMINATION_GRACE_MS,
        signal: combined,
      }
      handle = subprocess.spawn(spec)
    } catch (error) {
      rethrowAbort(signal, timeout.signal)
      throw new Error('git failed to start', { cause: error })
    }

    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error) {
      rethrowAbort(signal, timeout.signal)
      throw new Error('git failed to start', { cause: error })
    }

    rethrowAbort(signal, timeout.signal)

    if (outcome.exitCode !== 0) {
      throw new Error('git command failed')
    }

    const stdout = readCollected(handle.collected.stdout)
    const stderr = readCollected(handle.collected.stderr)
    if (stdout.lossy || stderr.lossy) {
      throw new Error('git output exceeded the collection limit')
    }
    return stdout.text
  } finally {
    clearTimeout(timer)
  }
}

export function parsePorcelainZ(text: string): string[] {
  if (text === '') return []
  const records = text.split('\0')
  const result: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (record === '') {
      if (index === records.length - 1) continue
      throw new Error('malformed git porcelain record: empty record')
    }
    // `XY PATH` is two status characters, a space, then a non-empty path.
    if (record.length < 4) {
      throw new Error('malformed git porcelain record: short record')
    }
    // A rename/copy is signalled by R or C in either status column: the index
    // column (X) for staged renames, or the worktree column (Y) for unstaged
    // renames recorded via intent-to-add. Both consume the trailing source.
    const x = record[0]!
    const y = record[1]!
    const path = record.slice(3)
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const source = records[index + 1]
      if (source === undefined || source === '') {
        throw new Error('malformed git porcelain record: rename or copy without source')
      }
      index += 1
      if (path !== HANDOFF_PATH) result.push(`${record} <- ${source}`)
      continue
    }
    if (path !== HANDOFF_PATH) result.push(record)
  }
  return result
}

function normalizeRelative(root: string, cwd: string): string {
  const rel = relative(root, cwd).replace(/\\/g, '/')
  return rel === '' ? '.' : rel
}

function stateDigest(branch: string, head: string, changedFiles: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([branch, head, changedFiles])).digest('hex')
}

export async function captureGit(
  subprocess: SubprocessService,
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<GitSnapshot> {
  signal?.throwIfAborted()
  const root = (await runGit(subprocess, cwd, ARGV_ROOT, signal, timeoutMs)).trim()
  const head = (await runGit(subprocess, root, ARGV_HEAD, signal, timeoutMs)).trim()
  const branch = (await runGit(subprocess, root, ARGV_BRANCH, signal, timeoutMs)).trim()
  const status = await runGit(subprocess, root, ARGV_STATUS, signal, timeoutMs)
  const changedFiles = parsePorcelainZ(status)
  return {
    root,
    relativeCwd: normalizeRelative(root, cwd),
    branch,
    head,
    changedFiles,
    stateDigest: stateDigest(branch, head, changedFiles),
  }
}
