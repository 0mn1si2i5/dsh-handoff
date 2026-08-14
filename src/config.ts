import z from '@deepseek-ai/schemastery'
import type { HandoffConfig, ResolvedHandoffConfig } from './types.ts'

const ALLOWED_KEYS = new Set([
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'maxDocumentBytes',
  'gitTimeoutMs',
])

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_DOCUMENT_BYTES = 32768
const DEFAULT_GIT_TIMEOUT_MS = 10000

export const Config: z<HandoffConfig> = z.object({
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number(),
  maxDocumentBytes: z.number(),
  gitTimeoutMs: z.number(),
})

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

export function resolveConfig(config: HandoffConfig): ResolvedHandoffConfig {
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`unknown configuration key: ${key}`)
    }
  }

  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider === undefined && model !== undefined) {
    throw new Error('summarizationProvider and summarizationModel must be configured together')
  }
  if (provider !== undefined && model === undefined) {
    throw new Error('summarizationProvider and summarizationModel must be configured together')
  }
  if (provider !== undefined && provider.length === 0) {
    throw new Error('summarizationProvider must be a non-empty string')
  }
  if (model !== undefined && model.length === 0) {
    throw new Error('summarizationModel must be a non-empty string')
  }

  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxDocumentBytes = config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
  const gitTimeoutMs = config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS

  assertPositiveSafeInteger(maxTokens, 'maxTokens')
  assertPositiveSafeInteger(maxDocumentBytes, 'maxDocumentBytes')
  assertPositiveSafeInteger(gitTimeoutMs, 'gitTimeoutMs')

  return {
    summarizationProvider: provider ?? '',
    summarizationModel: model ?? '',
    maxTokens,
    maxDocumentBytes,
    gitTimeoutMs,
  }
}
