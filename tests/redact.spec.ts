import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { mergeRedactionCounts, redactMessages, redactText } from '../src/redact.ts'

describe('handoff redaction', () => {
  it('redacts supported credential forms without returning original values', () => {
    const input = [
      '//registry.npmjs.org/:_authToken=npm_FAKE_1234567890',
      'Authorization: Bearer bearer_FAKE_1234567890',
      'postgres://user:password_FAKE@localhost/db',
      '-----BEGIN PRIVATE KEY-----\nFAKEKEYDATA\n-----END PRIVATE KEY-----',
    ].join('\n')
    const result = redactText(input, {})
    expect(result.text).not.toContain('FAKE')
    expect(result.text).toContain('<redacted:npm-token>')
    expect(Object.values(result.counts).reduce((sum, count) => sum + count, 0)).toBe(4)
  })

  it('redacts long sensitive environment values but leaves short values alone', () => {
    const result = redactText('long_ENV_FAKE_123 short', {
      API_TOKEN: 'long_ENV_FAKE_123',
      PASSWORD: 'short',
      ORDINARY: 'long_ENV_FAKE_456',
    })
    expect(result.text).toBe('<redacted:environment> short')
  })

  it('redacts every string inside a detached message copy', () => {
    const original = createUserMessage({
      content: [{ type: 'text', text: 'npm_FAKE_1234567890' }],
      source: { kind: 'user' },
    })
    const result = redactMessages([original], {})
    expect(JSON.stringify(result.value)).not.toContain('npm_FAKE_1234567890')
    expect(original.content[0]).toMatchObject({ text: 'npm_FAKE_1234567890' })
  })

  it('merges category counts without mutating inputs', () => {
    expect(mergeRedactionCounts({ 'api-token': 1 }, { 'api-token': 2, password: 1 }))
      .toEqual({ 'api-token': 3, password: 1 })
  })
})
