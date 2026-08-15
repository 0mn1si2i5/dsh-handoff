import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handoffDigest, parseHandoffDocument, parseSummaryMarkdown, renderHandoffDocument } from '../src/document.ts'
import type { HandoffMetadata, RedactionCounts, SummarySections } from '../src/types.ts'

const metadata = {
  generated: '2026-08-15T00:00:00.000Z',
  sourceSession: 'source-session',
  capturedThroughSeq: 12,
  workspace: '.',
  gitBranch: 'main',
  gitHead: '0123456789abcdef0123456789abcdef01234567',
  gitStateDigest: 'a'.repeat(64),
} as const

const completeSummary: SummarySections = {
  objective: 'Implement handoff',
  userRequirementsAndDecisions: 'Preserve exact paths and commands',
  completedWork: 'Built the versioned Markdown codec',
  currentState: 'Ready for review',
  validation: 'pnpm test passes',
  failedAttemptsAndWarnings: '(none)',
  remainingWork: 'Run the next planned task',
  recommendedNextAction: 'Run the next planned task',
  criticalReferences: 'src/index.ts',
}

const FINAL_HEADINGS = [
  'Objective',
  'User Requirements and Decisions',
  'Completed Work',
  'Current State',
  'Changed Files',
  'Validation',
  'Failed Attempts and Warnings',
  'Remaining Work',
  'Recommended Next Action',
  'Critical References',
  'Redaction Warnings',
] as const

const MODEL_HEADINGS = [
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

const modelBodies: readonly string[] = [
  'Implement handoff',
  'Preserve exact paths and commands',
  'Built the versioned Markdown codec',
  'Ready for review',
  'pnpm test passes',
  '(none)',
  'Run the next planned task',
  'Run the next planned task',
  'src/index.ts',
]

function renderDocument(
  changedFiles: readonly string[] = [' M src/index.ts'],
  redactions: Readonly<RedactionCounts> = { 'npm-token': 1 },
): string {
  return renderHandoffDocument({ metadata, summary: completeSummary, changedFiles, redactions })
}

function buildSummaryMarkdown(headings: readonly string[] = MODEL_HEADINGS, bodies: readonly string[] = modelBodies): string {
  return headings.map((heading, index) => `## ${heading}\n${bodies[index] ?? ''}`).join('\n\n')
}

describe('parseSummaryMarkdown', () => {
  it('accepts the nine model headings in order', () => {
    expect(parseSummaryMarkdown(buildSummaryMarkdown())).toEqual(completeSummary)
  })

  it('rejects preamble before the first heading', () => {
    expect(() => parseSummaryMarkdown(`intro\n${buildSummaryMarkdown()}`)).toThrow()
  })

  it('rejects a missing heading', () => {
    expect(() => parseSummaryMarkdown(buildSummaryMarkdown(MODEL_HEADINGS.slice(0, 8), modelBodies.slice(0, 8)))).toThrow()
  })

  it('rejects a duplicate heading', () => {
    const duplicated = buildSummaryMarkdown().replace('## Objective\n', '## Objective\n## Objective\n')
    expect(() => parseSummaryMarkdown(duplicated)).toThrow()
  })

  it('rejects an unknown heading', () => {
    const unknown = buildSummaryMarkdown().replace('## Validation\n', '## Bogus\n')
    expect(() => parseSummaryMarkdown(unknown)).toThrow()
  })

  it('rejects an empty section', () => {
    const empty = buildSummaryMarkdown().replace('## Validation\npnpm test passes', '## Validation')
    expect(() => parseSummaryMarkdown(empty)).toThrow()
  })

  it('rejects a reordered heading', () => {
    const reordered = buildSummaryMarkdown().replace(
      '## Validation\npnpm test passes\n\n## Failed Attempts and Warnings\n(none)',
      '## Failed Attempts and Warnings\n(none)\n\n## Validation\npnpm test passes',
    )
    expect(() => parseSummaryMarkdown(reordered)).toThrow()
  })
})

describe('handoff document codec', () => {
  it('round-trips one complete v1 document', () => {
    const text = renderHandoffDocument({
      metadata,
      summary: completeSummary,
      changedFiles: [' M src/index.ts'],
      redactions: { 'npm-token': 1 },
    })
    const parsed = parseHandoffDocument(text, 32768)
    expect(parsed.format).toBe('dsh-handoff/v1')
    expect(parsed.metadata).toEqual(metadata)
    expect(parsed.summary).toEqual(completeSummary)
    expect(parsed.changedFiles).toEqual([' M src/index.ts'])
    expect(parsed.redactions).toEqual({ 'npm-token': 1 })
    expect(parsed.text).toBe(text)
    expect(parsed.digest).toBe(handoffDigest(text))
    expect(text.endsWith('\n')).toBe(true)
  })

  it('renders (none) for empty deterministic lists', () => {
    const text = renderDocument([], {})
    const parsed = parseHandoffDocument(text, 32768)
    expect(parsed.changedFiles).toEqual([])
    expect(parsed.redactions).toEqual({})
    expect(text).toContain('## Changed Files\n(none)')
    expect(text).toContain('## Redaction Warnings\n(none)')
  })

  it('renders the eleven final headings in the fixed order', () => {
    const text = renderDocument()
    let previous = -1
    for (const heading of ['# DSH Handoff', ...FINAL_HEADINGS.map(heading => `## ${heading}`)]) {
      const at = text.indexOf(heading)
      expect(at).toBeGreaterThan(previous)
      previous = at
    }
  })

  it('rejects documents that exceed the UTF-8 byte limit', () => {
    const text = renderDocument()
    const bytes = Buffer.byteLength(text, 'utf8')
    expect(() => parseHandoffDocument(text, bytes - 1)).toThrow()
    expect(() => parseHandoffDocument(text, bytes)).not.toThrow()
  })

  it('rejects duplicate metadata fields', () => {
    const duplicated = renderDocument().replace(
      'Generated: 2026-08-15T00:00:00.000Z',
      'Generated: 2026-08-15T00:00:00.000Z\nGenerated: 2026-08-15T00:00:00.000Z',
    )
    expect(() => parseHandoffDocument(duplicated, 32768)).toThrow()
  })

  it('rejects an unknown format version', () => {
    const text = renderDocument().replace('Format: dsh-handoff/v1', 'Format: dsh-handoff/v2')
    expect(() => parseHandoffDocument(text, 32768)).toThrow()
  })

  it('accepts null capturedThroughSeq and rejects invalid values', () => {
    const nullSeq: HandoffMetadata = { ...metadata, capturedThroughSeq: null }
    const valid = renderHandoffDocument({
      metadata: nullSeq,
      summary: completeSummary,
      changedFiles: [],
      redactions: {},
    })
    expect(parseHandoffDocument(valid, 32768).metadata.capturedThroughSeq).toBeNull()

    for (const invalid of ['-1', '1.5', '9007199254740993', 'text']) {
      const text = renderDocument().replace('Captured through seq: 12', `Captured through seq: ${invalid}`)
      expect(() => parseHandoffDocument(text, 32768)).toThrow()
    }
  })

  it('requires a 40-hex Git HEAD', () => {
    const text = renderDocument().replace(
      'Git HEAD: 0123456789abcdef0123456789abcdef01234567',
      'Git HEAD: 0123456789abcdef0123456789abcdef0123456',
    )
    expect(() => parseHandoffDocument(text, 32768)).toThrow()
  })

  it('requires a 64-hex Git state digest', () => {
    const text = renderDocument().replace(`Git state digest: ${'a'.repeat(64)}`, `Git state digest: ${'a'.repeat(63)}`)
    expect(() => parseHandoffDocument(text, 32768)).toThrow()
  })

  it('normalizes CRLF to LF once and digests the normalized text', () => {
    const text = renderDocument()
    const crlf = text.replace(/\n/g, '\r\n')
    const parsed = parseHandoffDocument(crlf, 32768)
    expect(parsed.text).toBe(text)
    expect(parsed.digest).toBe(handoffDigest(text))
    expect(parsed.metadata).toEqual(metadata)
  })

  it('produces a stable SHA-256 digest over exact UTF-8 text', () => {
    const text = renderDocument()
    expect(handoffDigest(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(handoffDigest(text)).toMatch(/^[0-9a-f]{64}$/)
    expect(renderDocument()).toBe(text)
  })
})
