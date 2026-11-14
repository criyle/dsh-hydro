import { describe, expect, it } from 'vitest'
import { shellQuote, SshError, withEnvironment } from '../../src/ssh/index.js'

describe('shellQuote', () => {
  it('quotes simple values', () => {
    expect(shellQuote('abc')).toBe("'abc'")
  })

  it('quotes empty and whitespace values', () => {
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('a b\tc')).toBe("'a b\tc'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('quotes shell metacharacters so they cannot run commands', () => {
    const quoted = shellQuote('$(rm -rf /); `whoami` && echo "x"')
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    expect(quoted).not.toMatch(/[^']\$\(/)
  })

  it('round-trips through a shell-like single-quote decoder', () => {
    const value = `a'b"c$d\`e  f\n`
    const quoted = shellQuote(value)
    // POSIX single-quote decoding: '...' concatenation with \' escapes.
    const decoded = quoted.replace(/'\\''/g, "'").slice(1, -1)
    expect(decoded).toBe(value)
  })
})

describe('withEnvironment', () => {
  it('exports quoted environment variables before the command', () => {
    expect(withEnvironment('echo hi', { FOO: 'bar baz' })).toBe("export FOO='bar baz'; echo hi")
    expect(withEnvironment('echo hi', { A: '1', B: "x'y" })).toBe("export A='1' B='x'\\''y'; echo hi")
  })

  it('leaves the command untouched without env', () => {
    expect(withEnvironment('echo hi')).toBe('echo hi')
    expect(withEnvironment('echo hi', {})).toBe('echo hi')
  })

  it('rejects invalid environment variable names', () => {
    expect(() => withEnvironment('echo hi', { 'BAD;NAME': 'x' })).toThrow(SshError)
  })
})
