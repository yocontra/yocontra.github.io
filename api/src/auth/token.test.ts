import { describe, expect, it } from 'bun:test'
import { ACCESS_TTL_MS } from '../../../src/experiments/out-west/contract/auth.ts'
import { b64urlToBytes, bytesToB64url, s256, safeEqual, utf8 } from './crypto.ts'
import { TEST_SECRET } from './d1-fake.ts'
import { signAccessToken, verifyAccessToken } from './token.ts'

const input = {
  // biome-ignore lint/security/noSecrets: a fake account id
  accountId: 'acct_1234567890abcdef',
  name: 'Wild Bill',
  sid: 'family-1',
  platform: 'web' as const,
  authTime: 1_700_000_000_000,
}
const NOW = 1_700_000_100_000

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const { token, expiresAt } = await signAccessToken(TEST_SECRET, input, NOW)
    expect(expiresAt).toBe(Math.floor(NOW / 1000) * 1000 + ACCESS_TTL_MS)
    const claims = await verifyAccessToken(TEST_SECRET, token, NOW + 1000)
    expect(claims).toMatchObject({
      sub: input.accountId,
      name: 'Wild Bill',
      sid: 'family-1',
      plat: 'web',
      auth_time: 1_700_000_000,
    })
  })

  it('expires after 15 minutes', async () => {
    const { token } = await signAccessToken(TEST_SECRET, input, NOW)
    expect(await verifyAccessToken(TEST_SECRET, token, NOW + ACCESS_TTL_MS - 1000)).not.toBeNull()
    expect(await verifyAccessToken(TEST_SECRET, token, NOW + ACCESS_TTL_MS)).toBeNull()
  })

  it('rejects tokens from the future (beyond skew)', async () => {
    const { token } = await signAccessToken(TEST_SECRET, input, NOW + 5 * 60_000)
    expect(await verifyAccessToken(TEST_SECRET, token, NOW)).toBeNull()
  })

  it('rejects another secret, tampering and junk', async () => {
    const { token } = await signAccessToken(TEST_SECRET, input, NOW)
    expect(await verifyAccessToken('another-secret-of-length', token, NOW)).toBeNull()
    const [h, p, s] = token.split('.')
    const forged = bytesToB64url(utf8(JSON.stringify({ sub: 'someone-else', exp: 9e9 })))
    expect(await verifyAccessToken(TEST_SECRET, `${h}.${forged}.${s}`, NOW)).toBeNull()
    expect(await verifyAccessToken(TEST_SECRET, `${h}.${p}.${s}x`, NOW)).toBeNull()
    expect(await verifyAccessToken(TEST_SECRET, `${h}.${p}`, NOW)).toBeNull()
    expect(await verifyAccessToken(TEST_SECRET, '', NOW)).toBeNull()
    expect(await verifyAccessToken(TEST_SECRET, 'a.b.c', NOW)).toBeNull()
    // alg confusion: an unsigned "none" header never verifies
    const none = bytesToB64url(utf8(JSON.stringify({ alg: 'none', typ: 'JWT' })))
    expect(await verifyAccessToken(TEST_SECRET, `${none}.${p}.`, NOW)).toBeNull()
  })

  it('refuses to run with a missing or short secret', async () => {
    await expect(signAccessToken('short', input, NOW)).rejects.toThrow()
  })
})

describe('crypto helpers', () => {
  it('base64url round-trips and rejects junk', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 1, 2, 3])
    expect(b64urlToBytes(bytesToB64url(bytes))).toEqual(bytes)
    expect(b64urlToBytes('not base64!')).toBeNull()
  })

  it('computes RFC 7636 S256', async () => {
    // Appendix B of RFC 7636
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    // biome-ignore lint/security/noSecrets: the RFC's published test vector
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    expect(await s256(verifier)).toBe(challenge)
  })

  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
