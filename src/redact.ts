import type { Message } from '@deepseek-ai/dsh-llm'
import type { RedactionCounts, SecretKind } from './types.ts'

const MIN_CREDENTIAL_CHARS = 8

interface RegexRule {
  readonly kind: 'regex'
  readonly category: SecretKind
  readonly regex: RegExp
  readonly replacement: string
}

interface AssignmentRule {
  readonly kind: 'assignment'
  readonly category: SecretKind
  readonly name: RegExp
  readonly marker: string
}

type Rule = RegexRule | AssignmentRule

interface ValueSpan {
  readonly length: number
  readonly contentLength: number
}

// Fixed order: private-key blocks, npm tokens, authorization values, URL
// userinfo passwords, common prefixed API tokens, generic assignments. npm
// tokens must run before the generic API-token assignment so `_authToken=`
// values are classified as npm rather than a bare `token=` assignment.
//
// Regex rules handle private-key blocks, prefixed tokens, Authorization
// values, and URL userinfo passwords. The three assignment rules (`_authToken`,
// `password`, and the generic api_key/token/secret form) use the value-span
// scanner below so a quoted value with escapes, an unterminated quote, or a
// closing quote followed by an adjacent suffix is consumed as a single span
// rather than leaking the tail of a secret.
const RULES: readonly Rule[] = [
  {
    kind: 'regex',
    category: 'private-key',
    regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
    replacement: '<redacted:private-key>',
  },
  { kind: 'assignment', category: 'npm-token', name: /_authToken/, marker: '<redacted:npm-token>' },
  {
    kind: 'regex',
    category: 'npm-token',
    regex: /npm_[^\s,;]{8,}/g,
    replacement: '<redacted:npm-token>',
  },
  {
    kind: 'regex',
    category: 'authorization',
    regex: /(Bearer|Basic)\s+[^\s,;]{8,}/gi,
    replacement: '$1 <redacted:authorization>',
  },
  {
    kind: 'regex',
    category: 'password',
    regex: /(:\/\/[^/\s:@]+:)([^@\s]{8,})(@)/g,
    replacement: '$1<redacted:password>$3',
  },
  {
    kind: 'regex',
    category: 'api-token',
    regex: /(sk_|dsk_|ghp_|github_pat_)[^\s,;]{8,}/g,
    replacement: '<redacted:api-token>',
  },
  { kind: 'assignment', category: 'password', name: /password/i, marker: '<redacted:password>' },
  {
    kind: 'assignment',
    category: 'api-token',
    name: /\b(?:api[_-]?key|token|secret)\b/i,
    marker: '<redacted:api-token>',
  },
]

const VALUE_SEPARATOR = /[\s,;]/

function isValueSeparator(char: string): boolean {
  return VALUE_SEPARATOR.test(char)
}

function isHorizontalWhitespace(char: string): boolean {
  return char === ' ' || char === '\t'
}

function scanUnquoted(text: string, start: number): ValueSpan {
  let index = start
  while (index < text.length && !isValueSeparator(text[index]!)) index += 1
  return { length: index - start, contentLength: index - start }
}

function scanAdjacentSuffix(text: string, start: number): ValueSpan {
  const first = text[start]
  if (first === undefined || isValueSeparator(first)) return { length: 0, contentLength: 0 }
  return scanUnquoted(text, start)
}

// Consume one credential value starting at `start` (just past the assignment
// separator). Handles quoted and unquoted values, backslash escapes, an
// unterminated quote (consumed to the end of the line), and a closing quote
// followed by an adjacent non-separator suffix. Never crosses a newline.
function scanValueSpan(text: string, start: number): ValueSpan {
  const first = text[start]
  if (first !== '"' && first !== "'") return scanUnquoted(text, start)

  const quote = first
  let index = start + 1
  let contentLength = 0
  let closed = false

  while (index < text.length) {
    const char = text[index]!
    if (char === '\n' || char === '\r') break
    if (char === '\\') {
      const next = text[index + 1]
      if (next !== undefined && next !== '\n' && next !== '\r') {
        contentLength += 1
        index += 2
      } else {
        contentLength += 1
        index += 1
      }
      continue
    }
    if (char === quote) {
      closed = true
      index += 1
      break
    }
    contentLength += 1
    index += 1
  }

  if (!closed) return { length: index - start, contentLength }

  const suffix = scanAdjacentSuffix(text, index)
  return { length: index - start + suffix.length, contentLength: contentLength + suffix.contentLength }
}

function matchAssignmentSeparator(text: string, nameEnd: number): { text: string; end: number } | null {
  let index = nameEnd
  while (index < text.length && isHorizontalWhitespace(text[index]!)) index += 1
  if (index >= text.length) return null
  const char = text[index]!
  if (char !== '=' && char !== ':') return null
  index += 1
  while (index < text.length && isHorizontalWhitespace(text[index]!)) index += 1
  return { text: text.slice(nameEnd, index), end: index }
}

function redactAssignments(text: string, name: RegExp, marker: string): { text: string; count: number } {
  const flags = name.global ? name.flags : `${name.flags}g`
  const pattern = new RegExp(name.source, flags)
  let output = ''
  let copied = 0
  let count = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index < copied) continue
    const nameEnd = index + match[0].length
    const separator = matchAssignmentSeparator(text, nameEnd)
    if (separator === null) continue
    const span = scanValueSpan(text, separator.end)
    if (span.contentLength < MIN_CREDENTIAL_CHARS) continue

    output += text.slice(copied, nameEnd) + separator.text + marker
    copied = separator.end + span.length
    count += 1
  }
  output += text.slice(copied)
  return { text: output, count }
}

export interface RedactionResult<T> {
  readonly value: T
  readonly counts: Readonly<RedactionCounts>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSensitiveEnvName(name: string): boolean {
  return /(?:key|token|secret|password)/i.test(name)
}

function applyRule(text: string, rule: Rule): { text: string; count: number } {
  if (rule.kind === 'regex') {
    const matches = text.match(rule.regex)
    const count = matches === null ? 0 : matches.length
    return { text: text.replace(rule.regex, rule.replacement), count }
  }
  return redactAssignments(text, rule.name, rule.marker)
}

function addCount(target: RedactionCounts, category: SecretKind, count: number): void {
  if (count === 0) return
  target[category] = (target[category] ?? 0) + count
}

function compareByLengthThenValue(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function redactEnvironment(text: string, env: NodeJS.ProcessEnv): { text: string; count: number } {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_CREDENTIAL_CHARS) continue
    if (!isSensitiveEnvName(name)) continue
    values.add(value)
  }
  let output = text
  let count = 0
  // Deduplicate, then process longest first so a shorter value that is a
  // prefix of a longer value can never leave the longer secret's suffix
  // exposed. The value tie-break keeps the order independent of key order.
  for (const value of [...values].sort(compareByLengthThenValue)) {
    const pattern = new RegExp(escapeRegExp(value), 'g')
    const matches = output.match(pattern)
    if (matches === null) continue
    output = output.replace(pattern, '<redacted:environment>')
    count += matches.length
  }
  return { text: output, count }
}

export function redactText(text: string, env: NodeJS.ProcessEnv): { text: string; counts: Readonly<RedactionCounts> } {
  const counts: RedactionCounts = {}
  let output = text
  for (const rule of RULES) {
    const result = applyRule(output, rule)
    output = result.text
    addCount(counts, rule.category, result.count)
  }
  const environment = redactEnvironment(output, env)
  addCount(counts, 'environment', environment.count)
  return { text: environment.text, counts }
}

function redactInPlace(value: unknown, env: NodeJS.ProcessEnv, counts: RedactionCounts): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]
      if (typeof item === 'string') {
        const result = redactText(item, env)
        value[index] = result.text
        for (const [category, count] of Object.entries(result.counts)) {
          if (count !== undefined) addCount(counts, category as SecretKind, count)
        }
      } else {
        redactInPlace(item, env, counts)
      }
    }
    return
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === 'string') {
        const result = redactText(item, env)
        record[key] = result.text
        for (const [category, count] of Object.entries(result.counts)) {
          if (count !== undefined) addCount(counts, category as SecretKind, count)
        }
      } else {
        redactInPlace(item, env, counts)
      }
    }
  }
}

export function redactMessages(messages: readonly Message[], env: NodeJS.ProcessEnv): RedactionResult<Message[]> {
  const value = structuredClone(messages) as Message[]
  const counts: RedactionCounts = {}
  redactInPlace(value, env, counts)
  return { value, counts }
}

export function mergeRedactionCounts(...counts: readonly RedactionCounts[]): Readonly<RedactionCounts> {
  const merged: RedactionCounts = {}
  for (const source of counts) {
    for (const [category, count] of Object.entries(source)) {
      if (count !== undefined) addCount(merged, category as SecretKind, count)
    }
  }
  return merged
}
