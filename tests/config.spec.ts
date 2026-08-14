import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('owns the documented defaults', () => {
    expect(resolveConfig({})).toEqual({
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 4096,
      maxDocumentBytes: 32768,
      gitTimeoutMs: 10000,
    })
  })

  it.each([
    [{ summarizationProvider: 'deepseek' }],
    [{ summarizationModel: 'deepseek-chat' }],
    [{ maxTokens: 0 }],
    [{ maxDocumentBytes: 1.5 }],
    [{ gitTimeoutMs: Number.MAX_SAFE_INTEGER + 1 }],
    [{ unknown: true }],
  ])('rejects invalid config %j', (config) => {
    expect(() => resolveConfig(config as never)).toThrow()
  })
})
