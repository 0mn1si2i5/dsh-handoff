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

  it('redacts complete Basic authorization values containing + and =', () => {
    const result = redactText('Authorization: Basic abcdefgh+SECRETTAIL==', {})
    expect(result.text).not.toContain('abcdefgh+SECRETTAIL==')
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toContain('<redacted:authorization>')
  })

  it('redacts complete Bearer authorization values containing / and =', () => {
    const result = redactText('Authorization: Bearer abcdefgh/SECRETTAIL==', {})
    expect(result.text).not.toContain('abcdefgh/SECRETTAIL==')
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toContain('<redacted:authorization>')
  })

  it('redacts complete npm _authToken values containing +, /, or =', () => {
    for (const value of ['abcdefgh+SECRETTAIL==', 'abcdefgh/SECRETTAIL==', 'abcdefgh=SECRETTAIL==']) {
      const result = redactText(`_authToken=${value}`, {})
      expect(result.text).not.toContain(value)
      expect(result.text).not.toContain('SECRETTAIL')
      expect(result.text).toContain('<redacted:npm-token>')
    }
  })

  it('redacts complete api_key/token/secret/password values containing .', () => {
    for (const key of ['api_key', 'token', 'secret', 'password']) {
      const result = redactText(`${key}=abcdefgh.SECRETTAIL`, {})
      expect(result.text).not.toContain('abcdefgh.SECRETTAIL')
      expect(result.text).not.toContain('SECRETTAIL')
    }
  })

  it('redacts environment values deterministically regardless of insertion order when one value is a prefix of another', () => {
    const text = 'start abcdefghSECRETTAIL end'
    const forward = redactText(text, { LONG_TOKEN: 'abcdefghSECRETTAIL', SHORT_TOKEN: 'abcdefgh' })
    const reversed = redactText(text, { SHORT_TOKEN: 'abcdefgh', LONG_TOKEN: 'abcdefghSECRETTAIL' })
    expect(forward.text).toBe('start <redacted:environment> end')
    expect(reversed.text).toBe(forward.text)
    expect(reversed.counts).toEqual(forward.counts)
    expect(forward.text).not.toContain('SECRETTAIL')
  })

  it('does not let a shorter environment value leak a longer secret suffix', () => {
    const result = redactText('prefix abcdefghSUFFIX suffix', { SHORT_TOKEN: 'abcdefgh', LONG_TOKEN: 'abcdefghSUFFIX' })
    expect(result.text).toBe('prefix <redacted:environment> suffix')
  })

  it('redacts the complete Bearer value across ~ without leaking the suffix', () => {
    const input = 'Authorization: Bearer abcdefgh~SECRETTAIL==\nX-Next: kept-field'
    const result = redactText(input, {})
    expect(result.text).not.toContain('abcdefgh~SECRETTAIL==')
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toContain('<redacted:authorization>')
    expect(result.text).toBe('Authorization: Bearer <redacted:authorization>\nX-Next: kept-field')
    expect(result.counts.authorization).toBe(1)
  })

  it('redacts the complete generic assignment value across ~ without leaking the suffix', () => {
    const input = 'token=abcdefgh~SECRETTAIL kept-field'
    const result = redactText(input, {})
    expect(result.text).not.toContain('abcdefgh~SECRETTAIL')
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toContain('<redacted:api-token>')
    expect(result.text).toBe('token=<redacted:api-token> kept-field')
    expect(result.counts['api-token']).toBe(1)
  })

  it('redacts the complete _authToken value across ~ without leaking the suffix', () => {
    const input = '_authToken=abcdefgh~SECRETTAIL\nregistry=https://example.com/'
    const result = redactText(input, {})
    expect(result.text).not.toContain('abcdefgh~SECRETTAIL')
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toContain('<redacted:npm-token>')
    expect(result.text).toBe('_authToken=<redacted:npm-token>\nregistry=https://example.com/')
    expect(result.counts['npm-token']).toBe(1)
  })

  it('redacts complete npm_ and sk_ prefixed tokens across ~ without leaking the suffix', () => {
    const input = 'npm_abcdefgh~SECRETTAIL sk_abcdefgh~SECRETTAIL kept-field'
    const result = redactText(input, {})
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toBe('<redacted:npm-token> <redacted:api-token> kept-field')
    expect(result.counts['npm-token']).toBe(1)
    expect(result.counts['api-token']).toBe(1)
  })

  it('redacts a complete quoted assignment value without leaking its content', () => {
    const input = 'token="abcdefgh secret" kept-field'
    const result = redactText(input, {})
    expect(result.text).toBe('token=<redacted:api-token> kept-field')
    expect(result.counts['api-token']).toBe(1)
  })

  it('redacts a double-quoted value containing an escaped quote', () => {
    const input = String.raw`token="abcdefgh\"SECRETTAIL" kept-field`
    const result = redactText(input, {})
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toBe('token=<redacted:api-token> kept-field')
    expect(result.counts).toEqual({ 'api-token': 1 })
  })

  it('redacts a single-quoted value containing an escaped quote', () => {
    const input = String.raw`password='abcdefgh\'SECRETTAIL' kept-field`
    const result = redactText(input, {})
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toBe('password=<redacted:password> kept-field')
    expect(result.counts).toEqual({ password: 1 })
  })

  it('redacts an unterminated quoted value to end of line without crossing the newline', () => {
    const input = 'token="abcdefgh secret SECRETTAIL\nnext-field-kept'
    const result = redactText(input, {})
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toBe('token=<redacted:api-token>\nnext-field-kept')
    expect(result.counts).toEqual({ 'api-token': 1 })
  })

  it('redacts a closing quote followed by an adjacent non-separator suffix', () => {
    const input = 'token="abcdefgh"SECRETTAIL kept-field'
    const result = redactText(input, {})
    expect(result.text).not.toContain('SECRETTAIL')
    expect(result.text).toBe('token=<redacted:api-token> kept-field')
    expect(result.counts).toEqual({ 'api-token': 1 })
  })
})
