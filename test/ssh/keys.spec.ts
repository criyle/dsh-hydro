import { describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import { generateKeyPair } from '../../src/ssh/index.js'

describe('generateKeyPair', () => {
  it('generates an ssh2-parseable ed25519 keypair with a matching public key', async () => {
    const keyPair = await generateKeyPair('dsh-hydro-test')
    expect(keyPair.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')

    const parsed = ssh2.utils.parseKey(keyPair.privateKey)
    if (parsed instanceof Error) throw parsed
    expect(parsed.type).toBe('ssh-ed25519')

    const parts = keyPair.publicKey.split(' ')
    expect(parts[0]).toBe('ssh-ed25519')
    expect(parts[1]).toBe(parsed.getPublicSSH().toString('base64'))
    expect(parts[2]).toBe('dsh-hydro-test')
  })

  it('uses the default comment and produces unique keys', async () => {
    const first = await generateKeyPair()
    const second = await generateKeyPair()
    expect(first.publicKey.endsWith(' dsh-hydro')).toBe(true)
    expect(first.privateKey).not.toBe(second.privateKey)
    expect(first.publicKey).not.toBe(second.publicKey)
  })

  it('sanitizes comments with newlines', async () => {
    const keyPair = await generateKeyPair('hello\nworld')
    expect(keyPair.publicKey.split(' ').slice(2).join(' ')).toBe('hello world')
  })
})
