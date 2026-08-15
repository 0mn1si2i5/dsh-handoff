import type { Message } from '@deepseek-ai/dsh-llm'
import type { RedactionCounts, SecretKind } from './types.ts'

const MIN_CREDENTIAL_CHARS = 8

interface Rule {
  readonly category: SecretKind
  readonly regex: RegExp
  readonly replacement: string
}

// Fixed order: private-key blocks, npm tokens, authorization values, URL
// userinfo passwords, common prefixed API tokens, generic assignments. npm
// tokens must run before the generic API-token assignment so `_authToken=`
// values are classified as npm rather than a bare `token=` assignment.
const RULES: readonly Rule[] = [
  {
    category: 'private-key',
    regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
    replacement: '<redacted:private-key>',
  },
  {
    category: 'npm-token',
    regex: /_authToken=([A-Za-z0-9_\-]{8,})/g,
    replacement: '_authToken=<redacted:npm-token>',
  },
  {
    category: 'npm-token',
    regex: /npm_[A-Za-z0-9_\-]{8,}/g,
    replacement: '<redacted:npm-token>',
  },
  {
    category: 'authorization',
    regex: /(Bearer|Basic)\s+([A-Za-z0-9_\-.]{8,})/gi,
    replacement: '$1 <redacted:authorization>',
  },
  {
    category: 'password',
    regex: /(:\/\/[^/\s:@]+:)([^@\s]{8,})(@)/g,
    replacement: '$1<redacted:password>$3',
  },
  {
    category: 'api-token',
    regex: /(sk_|dsk_|ghp_|github_pat_)[A-Za-z0-9_\-]{8,}/g,
    replacement: '<redacted:api-token>',
  },
  {
    category: 'password',
    regex: /(password)(\s*[=:]\s*)([A-Za-z0-9_\-]{8,})/gi,
    replacement: '$1$2<redacted:password>',
  },
  {
    category: 'api-token',
    regex: /(api[_-]?key|token|secret)(\s*[=:]\s*)([A-Za-z0-9_\-]{8,})/gi,
    replacement: '$1$2<redacted:api-token>',
  },
]

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
  const matches = text.match(rule.regex)
  const count = matches === null ? 0 : matches.length
  return { text: text.replace(rule.regex, rule.replacement), count }
}

function addCount(target: RedactionCounts, category: SecretKind, count: number): void {
  if (count === 0) return
  target[category] = (target[category] ?? 0) + count
}

function redactEnvironment(text: string, env: NodeJS.ProcessEnv): { text: string; count: number } {
  let output = text
  let count = 0
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_CREDENTIAL_CHARS) continue
    if (!isSensitiveEnvName(name)) continue
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
