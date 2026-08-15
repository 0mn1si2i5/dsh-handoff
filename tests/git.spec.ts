import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { captureGit, parsePorcelainZ } from '../src/git.ts'

const execFileAsync = promisify(execFile)

describe('porcelain parser', () => {
  it('parses ordinary modifications and untracked files', () => {
    const text = ' M src/index.ts\0?? new-file.ts\0'
    expect(parsePorcelainZ(text)).toEqual([' M src/index.ts', '?? new-file.ts'])
  })

  it('normalizes a rename to `R  new <- old`', () => {
    const text = 'R  new name.ts\0old name.ts\0'
    expect(parsePorcelainZ(text)).toEqual(['R  new name.ts <- old name.ts'])
  })

  it('normalizes a copy', () => {
    const text = 'C  copied.ts\0original.ts\0'
    expect(parsePorcelainZ(text)).toEqual(['C  copied.ts <- original.ts'])
  })

  it('normalizes a first-column rename', () => {
    const text = 'R  new.ts\0old.ts\0'
    expect(parsePorcelainZ(text)).toEqual(['R  new.ts <- old.ts'])
  })

  it('normalizes a second-column rename', () => {
    const text = ' R new.ts\0old.ts\0'
    expect(parsePorcelainZ(text)).toEqual([' R new.ts <- old.ts'])
  })

  it('normalizes a first-column copy', () => {
    const text = 'C  copy.ts\0old.ts\0'
    expect(parsePorcelainZ(text)).toEqual(['C  copy.ts <- old.ts'])
  })

  it('normalizes a second-column copy', () => {
    const text = ' C copy.ts\0old.ts\0'
    expect(parsePorcelainZ(text)).toEqual([' C copy.ts <- old.ts'])
  })

  it('rejects a second-column rename or copy without a source path', () => {
    expect(() => parsePorcelainZ(' R new.ts\0')).toThrow()
    expect(() => parsePorcelainZ(' C copy.ts\0')).toThrow()
  })

  it('does not emit a second-column rename source as an independent record', () => {
    const text = ' R new.ts\0old.ts\0 M other.ts\0'
    expect(parsePorcelainZ(text)).toEqual([' R new.ts <- old.ts', ' M other.ts'])
  })

  it('preserves paths containing spaces', () => {
    const text = ' M dir with space/file name.ts\0'
    expect(parsePorcelainZ(text)).toEqual([' M dir with space/file name.ts'])
  })

  it('rejects a short record', () => {
    expect(() => parsePorcelainZ('M\0')).toThrow()
  })

  it('rejects a rename without a source path', () => {
    expect(() => parsePorcelainZ('R  new.ts\0')).toThrow()
  })

  it('rejects an empty record in the middle of the stream', () => {
    expect(() => parsePorcelainZ(' M a.ts\0\0 M b.ts\0')).toThrow()
  })

  it('always excludes docs/handoffs/current.md', () => {
    const text = ' M docs/handoffs/current.md\0 M src/index.ts\0'
    expect(parsePorcelainZ(text)).toEqual([' M src/index.ts'])
  })

  it('returns an empty list for empty input', () => {
    expect(parsePorcelainZ('')).toEqual([])
  })
})

describe('captureGit with a real repository', () => {
  it('captures changed files, excludes the handoff, and is deterministic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-git-'))
    // On macOS `tmpdir()` sits under `/var`, a symlink to `/private/var`; git
    // reports the canonical root, so canonicalize the directory before use.
    const root = await realpath(dir)
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessService)
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })

      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
      await execFileAsync('git', ['add', 'src/index.ts'], { cwd: root })
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root })

      // A committed file renamed in the worktree and recorded via intent-to-add:
      // porcelain -z reports ` R new.txt\0old.txt\0` (R in the worktree column),
      // so the parser must consume the trailing source record.
      await writeFile(join(root, 'old.txt'), 'old content\n')
      await execFileAsync('git', ['add', 'old.txt'], { cwd: root })
      await execFileAsync('git', ['commit', '-m', 'add old'], { cwd: root })
      await rename(join(root, 'old.txt'), join(root, 'new.txt'))
      await execFileAsync('git', ['add', '-N', 'new.txt'], { cwd: root })

      await writeFile(join(root, 'src', 'index.ts'), 'export const value = 2\n')
      await mkdir(join(root, 'docs', 'handoffs'), { recursive: true })
      await writeFile(join(root, 'docs', 'handoffs', 'current.md'), 'old handoff\n')

      const snapshot = await captureGit(ctx.subprocess, root, undefined, 10000)

      expect(snapshot.root).toBe(root)
      expect(snapshot.relativeCwd).toBe('.')
      expect(snapshot.branch).toBe('main')
      expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/)
      expect(snapshot.changedFiles).toContain(' M src/index.ts')
      const renames = snapshot.changedFiles.filter((file) => file.includes('<-'))
      expect(renames).toEqual([' R new.txt <- old.txt'])
      // The rename source and destination appear only inside the rename record.
      expect(snapshot.changedFiles.filter((file) => !file.includes('<-') && file.endsWith(' old.txt'))).toEqual([])
      expect(snapshot.changedFiles.filter((file) => !file.includes('<-') && file.endsWith(' new.txt'))).toEqual([])
      expect(snapshot.changedFiles.some(file => file.includes('docs/handoffs/current.md'))).toBe(false)

      const again = await captureGit(ctx.subprocess, root, undefined, 10000)
      expect(again.stateDigest).toBe(snapshot.stateDigest)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
