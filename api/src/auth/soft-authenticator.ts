/**
 * Test-only: a software passkey (ES256, `fmt: none`) that answers real WebAuthn options with real
 * signatures, so tests drive full ceremonies through `@simplewebauthn/server`. Owned by stream A.
 */
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { b64urlToBytes, bytesToB64url, randomBytes, sha256, utf8 } from './crypto.ts'

interface CreationOptions {
  challenge: string
  rp: { id?: string }
  user: { id: string }
}

interface RequestOptions {
  challenge: string
  rpId?: string
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const u32 = (n: number): Uint8Array =>
  new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])

/** WebCrypto's ECDSA output is raw r‖s; WebAuthn wants an ASN.1 DER sequence. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): Uint8Array => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) {
      i++
    }
    let v = bytes.slice(i)
    if ((v[0] ?? 0) & 0x80) {
      v = concat(new Uint8Array([0]), v)
    }
    return concat(new Uint8Array([0x02, v.length]), v)
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

export class SoftAuthenticator {
  readonly credentialId = bytesToB64url(randomBytes(16))
  readonly origin: string
  private keys: CryptoKeyPair | null = null
  private userHandle = ''
  private counter = 0

  constructor(origin: string) {
    this.origin = origin
  }

  private async clientData(type: string, challenge: string): Promise<Uint8Array<ArrayBuffer>> {
    await Promise.resolve()
    return utf8(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  /** Answers `navigator.credentials.create` options with a `RegistrationResponseJSON`. */
  async register(raw: unknown, rpId = 'localhost'): Promise<Record<string, unknown>> {
    const options = raw as CreationOptions
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    this.keys = keys
    this.userHandle = options.user.id
    const pub = new Uint8Array(
      (await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer,
    )
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, pub.slice(1, 33)],
      [-3, pub.slice(33, 65)],
    ])
    const credId = b64urlToBytes(this.credentialId) ?? new Uint8Array()
    const authData = concat(
      await sha256(options.rp.id ?? rpId),
      new Uint8Array([0x45]),
      u32(this.counter),
      new Uint8Array(16),
      new Uint8Array([credId.length >> 8, credId.length & 255]),
      credId,
      isoCBOR.encode(cose),
    )
    const attestation = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as Parameters<typeof isoCBOR.encode>[0],
    )
    const clientDataJSON = await this.clientData('webauthn.create', options.challenge)
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: bytesToB64url(clientDataJSON),
        attestationObject: bytesToB64url(attestation),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  /** Answers `navigator.credentials.get` options with an `AuthenticationResponseJSON`. */
  async assert(raw: unknown, rpId = 'localhost'): Promise<Record<string, unknown>> {
    const options = raw as RequestOptions
    if (!this.keys) {
      throw new Error('register first')
    }
    this.counter += 1
    const authData = concat(
      await sha256(options.rpId ?? rpId),
      new Uint8Array([0x05]),
      u32(this.counter),
    )
    const clientDataJSON = await this.clientData('webauthn.get', options.challenge)
    const signed = concat(authData, await sha256(clientDataJSON))
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed),
    )
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: bytesToB64url(clientDataJSON),
        authenticatorData: bytesToB64url(authData),
        signature: bytesToB64url(rawToDer(sig)),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    }
  }
}
