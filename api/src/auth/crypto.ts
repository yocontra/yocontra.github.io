/** Small WebCrypto helpers for auth: base64url, random ids, hashes, HMAC. Owned by stream A. */

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const B64URL = /^[A-Za-z0-9_-]*$/u
const PLUS = /\+/gu
const SLASH = /\//gu
const PADDING = /[=]+$/u
const DASH = /-/gu
const UNDERSCORE = /_/gu

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) {
    bin += String.fromCharCode(b)
  }
  return btoa(bin).replace(PLUS, '-').replace(SLASH, '_').replace(PADDING, '')
}

/** Decodes base64url (padding optional). Returns null on malformed input. */
export function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(text)) {
    return null
  }
  const b64 = text.replace(DASH, '+').replace(UNDERSCORE, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  try {
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text))
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes)

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** `n` random bytes as base64url (16 bytes = 128 bits = 22 characters). */
export const randomToken = (n = 16): string => bytesToB64url(randomBytes(n))

export async function sha256(data: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const input = typeof data === 'string' ? utf8(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await sha256(data)
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** PKCE S256: base64url(SHA-256(ascii(verifier))). */
export async function s256(verifier: string): Promise<string> {
  return bytesToB64url(await sha256(verifier))
}

/** Constant-time comparison of two strings (length leaks, contents don't). */
export function safeEqual(a: string, b: string): boolean {
  const x = utf8(a)
  const y = utf8(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  }
  return diff === 0
}

const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ])
    keyCache.set(secret, key)
  }
  return key
}

export async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(data))
  return new Uint8Array(sig)
}

/** WebCrypto's verify is constant time. */
export async function hmacVerify(
  secret: string,
  data: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  return await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, utf8(data))
}
