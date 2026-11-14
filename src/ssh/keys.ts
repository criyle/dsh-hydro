/**
 * SSH keypair generation.
 *
 * Keys are generated with `node:crypto` and encoded in the OpenSSH private key
 * format (for ed25519) or PKCS#1 PEM (RSA fallback), i.e. the formats ssh2's
 * client accepts. Accepted keys are validated through `ssh2.utils.parseKey`
 * before being returned.
 */

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import ssh2 from 'ssh2'
import { SshError } from './errors.js'

const { utils: ssh2Utils } = ssh2

export interface GeneratedKeyPair {
  /** Private key in a PEM format accepted by ssh2's client (`privateKey` option). */
  privateKey: string
  /** One-line `authorized_keys` entry: `ssh-ed25519 AAAA... comment`. */
  publicKey: string
}

const DEFAULT_COMMENT = 'dsh-hydro'

function writeUInt32BE(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

/** SSH wire encoding of a `string`. */
function sshString(data: Buffer): Buffer {
  return Buffer.concat([writeUInt32BE(data.length), data])
}

/** SSH wire encoding of an `mpint` (unsigned big-endian with sign padding). */
function sshMpint(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start++
  const trimmed = value.subarray(start)
  const needsPadding = trimmed.length > 0 && ((trimmed[0] as number) & 0x80) !== 0
  return sshString(needsPadding ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function sanitizeComment(comment: string | undefined): string {
  if (comment === undefined) return DEFAULT_COMMENT
  const sanitized = comment.replace(/[\r\n]+/g, ' ').trim()
  return sanitized.length === 0 ? DEFAULT_COMMENT : sanitized
}

function formatPublicKey(algo: string, blob: Buffer, comment: string): string {
  return `${algo} ${blob.toString('base64')} ${comment}`
}

/**
 * Encode an ed25519 key as an unencrypted OpenSSH private key
 * (`-----BEGIN OPENSSH PRIVATE KEY-----`).
 *
 * Node's `crypto` module cannot export this format directly, so the container
 * described by PROTOCOL.key is assembled by hand from the raw seed/public key.
 */
function encodeEd25519OpenSshKey(
  privateKey: KeyObject,
  publicKeyBlob: Buffer,
  publicKeyRaw: Buffer,
  comment: string,
): string {
  const privateJwk = privateKey.export({ format: 'jwk' })
  const seedBase64 = privateJwk.d
  if (typeof seedBase64 !== 'string') {
    throw new SshError('node:crypto did not expose the ed25519 private key seed')
  }
  const seed = Buffer.from(seedBase64, 'base64url')
  if (seed.length !== 32) throw new SshError('unexpected ed25519 private key seed length')

  const checkInt = randomBytes(4)
  const privateSection = Buffer.concat([
    writeUInt32BE(checkInt.readUInt32BE(0)),
    writeUInt32BE(checkInt.readUInt32BE(0)),
    sshString(Buffer.from('ssh-ed25519', 'utf8')),
    sshString(publicKeyRaw),
    sshString(Buffer.concat([seed, publicKeyRaw])),
    sshString(Buffer.from(comment, 'utf8')),
  ])
  const paddingLength = (8 - (privateSection.length % 8)) % 8
  const padding = Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1))
  const privateKeySection = Buffer.concat([privateSection, padding])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString(Buffer.from('none', 'utf8')), // cipher name
    sshString(Buffer.from('none', 'utf8')), // KDF name
    sshString(Buffer.alloc(0)), // KDF options
    writeUInt32BE(1), // number of keys
    sshString(publicKeyBlob),
    sshString(privateKeySection),
  ])
  const base64 = body.toString('base64')
  const wrapped = base64.match(/.{1,70}/g)?.join('\n') ?? base64
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`
}

function isAcceptedBySsh2(privateKeyPem: string, expectedPublicBlob: Buffer): boolean {
  const parsed = ssh2Utils.parseKey(privateKeyPem)
  if (parsed instanceof Error) return false
  try {
    return parsed.getPublicSSH().equals(expectedPublicBlob)
  } catch {
    return false
  }
}

function tryEd25519(comment: string): GeneratedKeyPair | undefined {
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicJwk = publicKey.export({ format: 'jwk' })
    const xBase64 = publicJwk.x
    if (typeof xBase64 !== 'string') return undefined
    const publicKeyRaw = Buffer.from(xBase64, 'base64url')
    if (publicKeyRaw.length !== 32) return undefined
    const publicKeyBlob = Buffer.concat([
      sshString(Buffer.from('ssh-ed25519', 'utf8')),
      sshString(publicKeyRaw),
    ])
    const privateKeyPem = encodeEd25519OpenSshKey(privateKey, publicKeyBlob, publicKeyRaw, comment)
    if (!isAcceptedBySsh2(privateKeyPem, publicKeyBlob)) return undefined
    return {
      privateKey: privateKeyPem,
      publicKey: formatPublicKey('ssh-ed25519', publicKeyBlob, comment),
    }
  } catch {
    return undefined
  }
}

function makeRsaKeyPair(comment: string): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs1' }).toString()
  const privateJwk = privateKey.export({ format: 'jwk' })
  const publicJwk = publicKey.export({ format: 'jwk' })
  const modulusBase64 = publicJwk.n ?? privateJwk.n
  const exponentBase64 = publicJwk.e ?? privateJwk.e
  if (typeof modulusBase64 !== 'string' || typeof exponentBase64 !== 'string') {
    throw new SshError('node:crypto did not expose the RSA public key components')
  }
  const publicKeyBlob = Buffer.concat([
    sshString(Buffer.from('ssh-rsa', 'utf8')),
    sshMpint(Buffer.from(exponentBase64, 'base64url')),
    sshMpint(Buffer.from(modulusBase64, 'base64url')),
  ])
  if (!isAcceptedBySsh2(privateKeyPem, publicKeyBlob)) {
    throw new SshError('Failed to generate an RSA keypair accepted by ssh2')
  }
  return {
    privateKey: privateKeyPem,
    publicKey: formatPublicKey('ssh-rsa', publicKeyBlob, comment),
  }
}

/**
 * Generate a new SSH keypair.
 *
 * Prefers ed25519 (OpenSSH private key format, accepted by ssh2). Falls back
 * to RSA 2048 (PKCS#1 PEM) if ed25519 is unavailable or cannot be encoded.
 *
 * `publicKey` is an `authorized_keys` line, e.g.
 * `ssh-ed25519 AAAAC3Nza... dsh-hydro`.
 */
export async function generateKeyPair(comment?: string): Promise<GeneratedKeyPair> {
  const sanitizedComment = sanitizeComment(comment)
  const ed25519 = tryEd25519(sanitizedComment)
  if (ed25519) return ed25519
  return makeRsaKeyPair(sanitizedComment)
}
