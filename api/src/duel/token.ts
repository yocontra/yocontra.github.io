/**
 * Reusable room tokens: HMAC over (room, account, seat). Valid for the life of the room, so a
 * player can reconnect within the grace without a fresh ticket. The room itself refuses tokens once
 * it has closed.
 */
import type { Env } from '../env.ts'
import type { Seat } from './judge-pvp.ts'

const encoder = new TextEncoder()
const PADDING = /[=]+$/u

function base64url(bytes: ArrayBuffer): string {
  let text = ''
  for (const b of new Uint8Array(bytes)) {
    text += String.fromCharCode(b)
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(PADDING, '')
}

async function key(env: Env): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(`duel-room|${env.AUTH_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function sign(env: Env, roomId: string, accountId: string, seat: Seat): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await key(env),
    encoder.encode(`${roomId}|${accountId}|${seat}`),
  )
  return base64url(mac)
}

/** `<seat>.<accountId>.<mac>` */
export async function roomToken(
  env: Env,
  roomId: string,
  accountId: string,
  seat: Seat,
): Promise<string> {
  return `${seat}.${accountId}.${await sign(env, roomId, accountId, seat)}`
}

export async function verifyRoomToken(
  env: Env,
  roomId: string,
  token: string,
): Promise<{ accountId: string; seat: Seat } | null> {
  const [seatText, accountId, mac] = token.split('.')
  if ((seatText !== '0' && seatText !== '1') || !accountId || !mac) {
    return null
  }
  const seat: Seat = seatText === '1' ? 1 : 0
  const expected = await sign(env, roomId, accountId, seat)
  // Constant-time-ish comparison of equal-length strings.
  if (expected.length !== mac.length) {
    return null
  }
  let diff = 0
  for (let i = 0; i < mac.length; i++) {
    diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0 ? { accountId, seat } : null
}
