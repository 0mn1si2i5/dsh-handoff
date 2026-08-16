import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

// The repository root, resolved from this test file's location, so the pack
// runs against the actual checkout regardless of the process cwd.
const ROOT = fileURLToPath(new URL('../', import.meta.url))

const EXPECTED_FILES = [
  'package/LICENSE',
  'package/README.md',
  'package/cordis.patch.yml',
  'package/lib/index.js',
  'package/lib/types/command.d.ts',
  'package/lib/types/config.d.ts',
  'package/lib/types/document.d.ts',
  'package/lib/types/error.d.ts',
  'package/lib/types/git.d.ts',
  'package/lib/types/index.d.ts',
  'package/lib/types/load.d.ts',
  'package/lib/types/redact.d.ts',
  'package/lib/types/save.d.ts',
  'package/lib/types/storage.d.ts',
  'package/lib/types/summarize.d.ts',
  'package/lib/types/types.d.ts',
  'package/package.json',
]

// Substrings that must never appear in any packed text file.
const FORBIDDEN_IN_TEXT = ['link:', '/Users/', '_authToken=', 'sourceMappingURL', 'file://']

// Package.json dependency sections whose version specs must stay registry-only.
const DEP_SECTIONS = ['dependencies', 'peerDependencies', 'devDependencies'] as const

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('package contents', () => {
  it('packs exactly the published bundle with no leaked paths or credentials', { timeout: 60_000 }, async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-handoff-pack-'))

    // Pack into a directory outside the repository. `prepack` (pnpm build)
    // runs first, so this also proves the shipping build produces the expected
    // declaration files.
    await execFileAsync('pnpm', ['pack', '--pack-destination', tempDir], { cwd: ROOT })

    const packed = await readdir(tempDir)
    const tgzFiles = packed.filter((entry) => entry.endsWith('.tgz'))
    expect(tgzFiles).toHaveLength(1)
    const tgz = join(tempDir, tgzFiles[0]!)

    // Read the tarball table, drop directory entries, and sort for a stable
    // exact comparison.
    const { stdout: listing } = await execFileAsync('tar', ['-tf', tgz])
    const files = listing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !line.endsWith('/'))
      .sort()

    expect(files).toEqual([...EXPECTED_FILES].sort())
    for (const absent of [
      'package/src/index.ts',
      'package/tests/package.spec.ts',
      'package/.npmrc',
      'package/AGENTS.md',
      'package/pnpm-lock.yaml',
    ]) {
      expect(files).not.toContain(absent)
    }
    expect(files.some((entry) => entry.includes('docs/superpowers'))).toBe(false)
    expect(files.some((entry) => entry.includes('node_modules'))).toBe(false)
    expect(files.some((entry) => entry.endsWith('.tgz'))).toBe(false)

    // Read every packed text file straight from the archive — never extract
    // into the repository — and reject forbidden substrings.
    const texts = new Map<string, string>()
    for (const entry of files) {
      const { stdout } = await execFileAsync('tar', ['-xOf', tgz, entry])
      texts.set(entry, stdout)
    }

    for (const [entry, text] of texts) {
      for (const forbidden of FORBIDDEN_IN_TEXT) {
        expect(text, `forbidden "${forbidden}" in ${entry}`).not.toContain(forbidden)
      }
    }

    // The packed manifest must point at files that are actually in the archive.
    const packedPkg = JSON.parse(texts.get('package/package.json')!) as {
      name: string
      version: string
      main: string
      types: string
      exports: { '.': { types: string; default: string } }
      files: string[]
      dsh: { bundle: { patch: string } }
      publishConfig: { access: string }
    } & Record<(typeof DEP_SECTIONS)[number], Record<string, string> | undefined>
    expect(packedPkg.name).toBe('dsh-handoff')
    expect(packedPkg.version).toBe('0.1.0')
    expect(packedPkg.publishConfig.access).toBe('public')
    expect(packedPkg.main).toBe('lib/index.js')
    expect(packedPkg.types).toBe('lib/types/index.d.ts')
    expect(packedPkg.exports['.'].default).toBe('./lib/index.js')
    expect(packedPkg.exports['.'].types).toBe('./lib/types/index.d.ts')
    expect(files).toContain('package/lib/index.js')
    expect(files).toContain('package/lib/types/index.d.ts')
    expect(packedPkg.dsh.bundle.patch).toBe('./cordis.patch.yml')

    for (const file of packedPkg.files) {
      expect(file).not.toContain('src')
      expect(file).not.toContain('tests')
      expect(file).not.toContain('.npmrc')
      expect(file).not.toContain('pnpm-lock')
    }

    for (const section of DEP_SECTIONS) {
      const deps = packedPkg[section] ?? {}
      for (const spec of Object.values(deps)) {
        expect(spec).not.toMatch(/^(link:|workspace:|file:)/)
      }
    }
  })
})
