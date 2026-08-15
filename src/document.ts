import { createHash } from 'node:crypto'
import type {
  HandoffDocumentInput,
  HandoffMetadata,
  ParsedHandoffDocument,
  RedactionCounts,
  SecretKind,
  SummarySections,
} from './types.ts'

const FORMAT = 'dsh-handoff/v1'

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

const SUMMARY_FIELDS: Record<string, keyof SummarySections> = {
  Objective: 'objective',
  'User Requirements and Decisions': 'userRequirementsAndDecisions',
  'Completed Work': 'completedWork',
  'Current State': 'currentState',
  Validation: 'validation',
  'Failed Attempts and Warnings': 'failedAttemptsAndWarnings',
  'Remaining Work': 'remainingWork',
  'Recommended Next Action': 'recommendedNextAction',
  'Critical References': 'criticalReferences',
}

export function handoffDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function formatCapturedThroughSeq(value: number | null): string {
  return value === null ? 'null' : String(value)
}

function renderRedactionWarnings(redactions: Readonly<RedactionCounts>): string {
  const categories = (Object.keys(redactions) as SecretKind[]).sort()
  if (categories.length === 0) return '(none)'
  return categories.flatMap((category) => {
    const count = redactions[category]
    return count === undefined ? [] : [`${category}: ${count}`]
  }).join('\n')
}

function renderSection(heading: string, input: HandoffDocumentInput): string {
  if (heading === 'Changed Files') {
    return input.changedFiles.length === 0 ? '(none)' : input.changedFiles.join('\n')
  }
  if (heading === 'Redaction Warnings') {
    return renderRedactionWarnings(input.redactions)
  }
  const field = SUMMARY_FIELDS[heading]
  if (field === undefined) throw new Error(`unexpected section: ${heading}`)
  return input.summary[field]
}

export function renderHandoffDocument(input: HandoffDocumentInput): string {
  const lines: string[] = [
    '# DSH Handoff',
    '',
    `Format: ${FORMAT}`,
    `Generated: ${input.metadata.generated}`,
    `Source session: ${input.metadata.sourceSession}`,
    `Captured through seq: ${formatCapturedThroughSeq(input.metadata.capturedThroughSeq)}`,
    `Workspace: ${input.metadata.workspace}`,
    `Git branch: ${input.metadata.gitBranch}`,
    `Git HEAD: ${input.metadata.gitHead}`,
    `Git state digest: ${input.metadata.gitStateDigest}`,
    '',
  ]
  for (const heading of FINAL_HEADINGS) {
    lines.push(`## ${heading}`)
    lines.push(renderSection(heading, input))
    lines.push('')
  }
  return lines.join('\n')
}

function readField(lines: readonly string[], index: number, label: string): string {
  const line = lines[index]
  if (line === undefined) throw new Error(`missing metadata field: ${label}`)
  const prefix = `${label}: `
  if (!line.startsWith(prefix)) throw new Error(`expected metadata field: ${label}`)
  return line.slice(prefix.length)
}

function parseCapturedThroughSeq(value: string): number | null {
  if (value === 'null') return null
  if (!/^\d+$/.test(value)) throw new Error('Captured through seq must be null or a non-negative safe integer')
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Captured through seq must be a non-negative safe integer')
  return number
}

function parseGitHead(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Git HEAD must be a 40-character hexadecimal string')
  return value
}

function parseGitStateDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Git state digest must be a 64-character hexadecimal string')
  return value
}

function parseChangedFiles(body: string): string[] {
  if (body === '(none)') return []
  return body.split('\n')
}

const SECRET_KINDS = new Set<string>([
  'api-token',
  'authorization',
  'private-key',
  'npm-token',
  'password',
  'environment',
])

function parseRedactionWarnings(body: string): RedactionCounts {
  if (body === '(none)') return {}
  const counts: RedactionCounts = {}
  for (const line of body.split('\n')) {
    const separator = line.indexOf(': ')
    if (separator < 0) throw new Error('invalid redaction warning line')
    const category = line.slice(0, separator)
    const countText = line.slice(separator + 2)
    if (!SECRET_KINDS.has(category)) throw new Error('unknown redaction category')
    if (counts[category as SecretKind] !== undefined) throw new Error('duplicate redaction category')
    const count = Number(countText)
    if (!/^[1-9][0-9]*$/.test(countText) || !Number.isSafeInteger(count)) {
      throw new Error('invalid redaction warning count')
    }
    counts[category as SecretKind] = count
  }
  return counts
}

function collectBody(body: readonly string[]): string {
  let start = 0
  let end = body.length
  while (start < end && body[start] === '') start += 1
  while (end > start && body[end - 1] === '') end -= 1
  return body.slice(start, end).join('\n')
}

function parseSectionLines(lines: readonly string[], startIndex: number, headings: readonly string[]): string[] {
  const bodies: string[] = []
  let headingIndex = 0
  let body: string[] | null = null

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim()
      if (headingIndex >= headings.length) throw new Error(`unexpected heading: ${heading}`)
      if (heading !== headings[headingIndex]) throw new Error(`unexpected heading: ${heading}`)
      if (body !== null) bodies.push(collectBody(body))
      body = []
      headingIndex += 1
    } else if (body === null) {
      throw new Error('preamble is not allowed')
    } else {
      body.push(line)
    }
  }

  if (body !== null) bodies.push(collectBody(body))
  if (headingIndex !== headings.length) throw new Error('missing section heading')
  for (let index = 0; index < bodies.length; index += 1) {
    if (bodies[index]!.trim() === '') throw new Error(`empty section: ${headings[index]}`)
  }
  return bodies
}

export function parseSummaryMarkdown(text: string): SummarySections {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const bodies = parseSectionLines(lines, 0, MODEL_HEADINGS)
  return {
    objective: bodies[0]!,
    userRequirementsAndDecisions: bodies[1]!,
    completedWork: bodies[2]!,
    currentState: bodies[3]!,
    validation: bodies[4]!,
    failedAttemptsAndWarnings: bodies[5]!,
    remainingWork: bodies[6]!,
    recommendedNextAction: bodies[7]!,
    criticalReferences: bodies[8]!,
  }
}

export function parseHandoffDocument(text: string, maxBytes: number): ParsedHandoffDocument {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('document exceeds the UTF-8 byte limit')
  }
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  let index = 0

  if (lines[index] !== '# DSH Handoff') throw new Error('document must begin with the title')
  index += 1
  if (lines[index] !== '') throw new Error('expected a blank line after the title')
  index += 1

  const format = readField(lines, index, 'Format')
  index += 1
  const generated = readField(lines, index, 'Generated')
  index += 1
  const sourceSession = readField(lines, index, 'Source session')
  index += 1
  const capturedThroughSeqRaw = readField(lines, index, 'Captured through seq')
  index += 1
  const workspace = readField(lines, index, 'Workspace')
  index += 1
  const gitBranch = readField(lines, index, 'Git branch')
  index += 1
  const gitHead = readField(lines, index, 'Git HEAD')
  index += 1
  const gitStateDigest = readField(lines, index, 'Git state digest')
  index += 1

  if (format !== FORMAT) throw new Error(`unknown format: ${format}`)

  if (lines[index] !== '') throw new Error('expected a blank line after metadata')
  index += 1

  const sections = parseSectionLines(lines, index, FINAL_HEADINGS)

  const metadata: HandoffMetadata = {
    generated,
    sourceSession,
    capturedThroughSeq: parseCapturedThroughSeq(capturedThroughSeqRaw),
    workspace,
    gitBranch,
    gitHead: parseGitHead(gitHead),
    gitStateDigest: parseGitStateDigest(gitStateDigest),
  }

  const summary: SummarySections = {
    objective: sections[0]!,
    userRequirementsAndDecisions: sections[1]!,
    completedWork: sections[2]!,
    currentState: sections[3]!,
    validation: sections[5]!,
    failedAttemptsAndWarnings: sections[6]!,
    remainingWork: sections[7]!,
    recommendedNextAction: sections[8]!,
    criticalReferences: sections[9]!,
  }

  return {
    format: FORMAT,
    metadata,
    summary,
    changedFiles: parseChangedFiles(sections[4]!),
    redactions: parseRedactionWarnings(sections[10]!),
    text: normalized,
    digest: handoffDigest(normalized),
  }
}
