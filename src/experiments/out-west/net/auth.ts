/**
 * Passkey accounts in the browser. The access token lives in memory only. The refresh token is an
 * HttpOnly cookie the page never sees, refreshed silently with `credentials: 'include'`. Inside the
 * Expo app, tokens come from the native bridge instead.
 *
 * Every call resolves to a typed result and never throws. Cancelling a passkey prompt comes back as
 * `{ ok: false, cancelled: true }`, so the UI can stay quiet. Owned by stream A.
 */
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  sendSignal,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser'
import {
  type AccountInfo,
  type AppAuthorizeRequest,
  type AuthSession,
  type CeremonyOptions,
  CLIENT_HEADER,
  type PasskeyInfo,
  type Player,
  type RefreshRequest,
  type TicketPurpose,
} from '../contract/auth.ts'
import { platform, provideWebTokens } from '../platform/bridge.ts'
import { pageTurnstile } from './turnstile.ts'

export type { Player } from '../contract/auth.ts'

export type AuthResult<T = Player> =
  | { ok: true; value: T }
  | { ok: false; error: string; cancelled?: boolean }

const FALLBACK = import.meta.env.DEV ? 'http://localhost:8787' : 'https://api.contra.io'
const configured: unknown = import.meta.env.PUBLIC_API_URL
/** The API origin (`PUBLIC_API_URL`, else localhost:8787 in dev, api.contra.io in prod). */
export const API_URL = (
  typeof configured === 'string' && configured ? configured : FALLBACK
).replace(/\/+$/u, '')

/** Refresh this long before the access token expires. */
const EARLY_REFRESH_MS = 60_000
const TIMEOUT_MS = 12_000
const RACE_RETRIES = 2
const RACE_DELAY_MS = 250
/** A hint (not a secret) that a refresh cookie probably exists, so guests skip a pointless 401. */
const HINT_KEY = 'ow-auth-hint'
const CHANNEL = 'ow-auth'
const LOCK = 'ow-auth-refresh'

interface Session {
  accessToken: string
  expiresAt: number
  player: Player
}

let session: Session | null = null
let restored = false
let refreshing: Promise<Session | null> | null = null
const listeners = new Set<(p: Player | null) => void>()
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function isSession(v: unknown): v is AuthSession {
  return (
    isRecord(v) &&
    typeof v.accessToken === 'string' &&
    typeof v.expiresAt === 'number' &&
    isRecord(v.player) &&
    typeof v.player.accountId === 'string' &&
    typeof v.player.name === 'string'
  )
}

function readHint(): Player | null {
  try {
    const raw = localStorage.getItem(HINT_KEY)
    const v: unknown = raw ? JSON.parse(raw) : null
    return isRecord(v) && typeof v.accountId === 'string' && typeof v.name === 'string'
      ? { accountId: v.accountId, name: v.name }
      : null
  } catch {
    return null
  }
}

function writeHint(p: Player | null): void {
  try {
    if (p) {
      localStorage.setItem(HINT_KEY, JSON.stringify(p))
    } else {
      localStorage.removeItem(HINT_KEY)
    }
  } catch {
    // private mode: we'll just try a refresh on every boot
  }
}

function setSession(next: Session | null, broadcast = true): void {
  const before = session?.player.accountId ?? null
  const beforeName = session?.player.name ?? null
  session = next
  writeHint(next?.player ?? null)
  const after = next?.player.accountId ?? null
  if (before === after && beforeName === (next?.player.name ?? null)) {
    return
  }
  if (broadcast) {
    channel?.postMessage(next ? { type: 'signin', accountId: after } : { type: 'signout' })
  }
  for (const cb of listeners) {
    try {
      cb(next?.player ?? null)
    } catch (err) {
      console.error('auth listener failed', err)
    }
  }
}

// Another tab signed in or out: follow it. Its access token stays there; ours refreshes from the
// shared cookie on demand.
//
// A tab that follows a sign-in never re-announces it. It used to: tab B heard A's `signin`, dropped
// its session, refreshed and broadcast `signin` again (its session had gone from null to a player),
// which made A do the same, forever. Every open tab (say the game plus an `/auth/app` handoff tab)
// rotated the refresh token in a loop, burned the refresh rate limit, and left a refresh in flight
// almost all the time, so any reload was likely to drop a rotated cookie. Now the same account is
// ignored outright, and a different one is followed without a broadcast.
channel?.addEventListener('message', (e: MessageEvent<unknown>) => {
  const data = isRecord(e.data) ? e.data : null
  if (data?.type === 'signout') {
    setSession(null, false)
  } else if (data?.type === 'signin') {
    if (session && session.player.accountId === data.accountId) {
      return
    }
    session = null
    void refresh(false)
  }
})

interface Reply {
  status: number
  body: unknown
}

async function api(path: string, init: RequestInit & { bearer?: string } = {}): Promise<Reply> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  headers.set(CLIENT_HEADER, 'web')
  if (init.bearer) {
    headers.set('Authorization', `Bearer ${init.bearer}`)
  }
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      ...init,
      headers,
      credentials: 'include',
      signal: ctrl.signal,
    })
    const body: unknown = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch {
    return { status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

function politeError(r: Reply, fallback: string): string {
  if (r.status === 0) {
    return navigator.onLine === false
      ? 'You look to be offline.'
      : 'Couldn’t reach the server. Try again in a moment.'
  }
  if (r.status === 429) {
    return 'Too many tries. Wait a minute and try again.'
  }
  if (isRecord(r.body) && typeof r.body.error === 'string') {
    return r.body.error
  }
  return r.status >= 500 ? 'Server trouble. Try again in a few minutes.' : fallback
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The server's 403 for "today's Turnstile check is still owed" (the cookie is left alone). */
const wantsTurnstile = (r: Reply): boolean =>
  r.status === 403 && isRecord(r.body) && r.body.turnstile === 'required'

async function refreshWith(body: RefreshRequest): Promise<Session | null | 'turnstile'> {
  for (let i = 0; i <= RACE_RETRIES; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: retries are sequential by nature
    const r = await api('/auth/refresh', { body: JSON.stringify(body) })
    if (r.status === 200 && isSession(r.body)) {
      const { accessToken, expiresAt, player } = r.body
      return { accessToken, expiresAt, player }
    }
    if (r.status === 409) {
      // another tab rotated the cookie a moment ago; the jar has the new one now
      await sleep(RACE_DELAY_MS * (i + 1))
      continue
    }
    if (wantsTurnstile(r)) {
      return 'turnstile'
    }
    if (r.status === 401) {
      setSession(null)
      return null
    }
    // offline or a 5xx: keep whoever we think is signed in, just no token right now
    return null
  }
  return null
}

async function refreshOnce(): Promise<Session | null> {
  const first = await refreshWith({})
  if (first !== 'turnstile') {
    return first
  }
  // The first refresh of the UTC day (§8): one token from the invisible widget, then one retry.
  // No token (script blocked, timed out) keeps whoever is signed in, just without an access token.
  const token = await pageTurnstile().take()
  if (!token) {
    return null
  }
  const second = await refreshWith({ turnstileToken: token })
  return second === 'turnstile' ? null : second
}

/**
 * Silent refresh, single-flight within the tab and serialised across tabs with a Web Lock.
 * `announce` is false when following another tab, which has already told everyone.
 */
function refresh(announce = true): Promise<Session | null> {
  refreshing ??= (async () => {
    try {
      const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
      const fresh = locks
        ? await locks.request(LOCK, async () => await refreshOnce())
        : await refreshOnce()
      if (fresh) {
        setSession(fresh, announce)
      }
      return fresh
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** A valid access token, refreshed silently when needed; null when signed out or offline. */
export async function getAccessToken(): Promise<string | null> {
  if (platform.kind !== 'web') {
    return await platform.tokens.getAccessToken()
  }
  if (session && session.expiresAt - Date.now() > EARLY_REFRESH_MS) {
    return session.accessToken
  }
  if (!(session || readHint())) {
    return null
  }
  return (await refresh())?.accessToken ?? null
}

provideWebTokens({ getAccessToken })

/** The signed-in player, or null. Before `restoreSession` resolves, this is the cached hint. */
export function currentPlayer(): Player | null {
  return session?.player ?? (restored ? null : readHint())
}

/** Subscribes to sign-in, sign-out and name changes. Returns an unsubscribe. Not called immediately. */
export function onAuthChange(cb: (p: Player | null) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Call once at boot: restores the session from the refresh cookie, if there is one. */
export function restoreSession(): Promise<Player | null> {
  restoring ??= (async () => {
    if (!session && readHint()) {
      await refresh()
    }
    restored = true
    return session?.player ?? null
  })()
  return restoring.then(() => session?.player ?? null)
}

let restoring: Promise<Player | null> | null = null

/** True when this browser can do passkeys at all. */
export const passkeysSupported = (): boolean => browserSupportsWebAuthn()

function ceremonyError(err: unknown): AuthResult<never> {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return { ok: false, error: 'Passkey prompt closed.', cancelled: true }
  }
  if (name === 'InvalidStateError') {
    return { ok: false, error: 'That passkey is already registered here.' }
  }
  if (name === 'SecurityError') {
    return { ok: false, error: 'Passkeys aren’t allowed on this address.' }
  }
  return { ok: false, error: 'The passkey prompt failed. Try again.' }
}

function isOptions(v: unknown): v is CeremonyOptions {
  return isRecord(v) && typeof v.challengeId === 'string' && isRecord(v.options)
}

async function finish(path: string, challengeId: string, response: unknown): Promise<AuthResult> {
  const r = await api(path, { body: JSON.stringify({ challengeId, response }) })
  if (!(r.status >= 200 && r.status < 300 && isSession(r.body))) {
    return { ok: false, error: politeError(r, 'That didn’t work. Try again.') }
  }
  const { accessToken, expiresAt, player } = r.body
  setSession({ accessToken, expiresAt, player })
  restored = true
  return { ok: true, value: player }
}

const turnstileToken = (): Promise<string | null> => pageTurnstile().take()

/** Creates an account named `name` with a new passkey. */
export async function signUp(name: string): Promise<AuthResult> {
  if (!passkeysSupported()) {
    return { ok: false, error: 'This browser can’t make passkeys.' }
  }
  const token = await turnstileToken()
  if (!token) {
    return { ok: false, error: 'Couldn’t check you’re human. Reload and try again.' }
  }
  const r = await api('/auth/register/options', {
    body: JSON.stringify({ name, turnstileToken: token }),
  })
  if (!isOptions(r.body)) {
    return { ok: false, error: politeError(r, 'Couldn’t start sign-up.') }
  }
  let response: unknown
  try {
    response = await startRegistration({
      optionsJSON: r.body.options as PublicKeyCredentialCreationOptionsJSON,
    })
  } catch (err) {
    return ceremonyError(err)
  }
  return await finish('/auth/register/verify', r.body.challengeId, response)
}

/**
 * Signs in with a saved passkey. With `conditional`, waits quietly for the user to pick a passkey
 * from autofill on an `<input autocomplete="username webauthn">` (resolves cancelled if aborted).
 */
export async function signIn(opts: { conditional?: boolean } = {}): Promise<AuthResult> {
  if (!passkeysSupported()) {
    return { ok: false, error: 'This browser can’t use passkeys.' }
  }
  if (opts.conditional && !(await browserSupportsWebAuthnAutofill())) {
    return { ok: false, error: 'No autofill here.', cancelled: true }
  }
  const r = await api('/auth/login/options', { body: '{}' })
  if (!isOptions(r.body)) {
    return { ok: false, error: politeError(r, 'Couldn’t start sign-in.') }
  }
  let response: unknown
  try {
    response = await startAuthentication({
      optionsJSON: r.body.options as PublicKeyCredentialRequestOptionsJSON,
      useBrowserAutofill: opts.conditional === true,
    })
  } catch (err) {
    return ceremonyError(err)
  }
  return await finish('/auth/login/verify', r.body.challengeId, response)
}

/** Stops a pending conditional sign-in (e.g. when the panel closes). */
export function cancelPendingSignIn(): void {
  WebAuthnAbortService.cancelCeremony()
}

/** Signs out here and revokes this session on the server. */
export async function signOut(): Promise<void> {
  const bearer = session?.accessToken
  await api('/auth/logout', { body: '{}', ...(bearer ? { bearer } : {}) })
  setSession(null)
}

/** Fetches the API with the bearer token, refreshing once on a 401. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string | null): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    return await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' })
  }
  const first = await send(await getAccessToken())
  if (first.status !== 401 || !session) {
    return first
  }
  session = { ...session, expiresAt: 0 }
  return await send(await getAccessToken())
}

/** A 30 s single-use WebSocket ticket for `purpose`. */
export async function getTicket(purpose: TicketPurpose): Promise<AuthResult<string>> {
  const bearer = await getAccessToken()
  if (!bearer) {
    return { ok: false, error: 'Sign in first.' }
  }
  const r = await api('/tickets', { bearer, body: JSON.stringify({ purpose }) })
  if (r.status === 201 && isRecord(r.body) && typeof r.body.ticket === 'string') {
    return { ok: true, value: r.body.ticket }
  }
  return { ok: false, error: politeError(r, 'Couldn’t get a connection ticket.') }
}

/** The account's details and passkeys. */
export async function accountInfo(): Promise<AuthResult<AccountInfo>> {
  const bearer = await getAccessToken()
  if (!bearer) {
    return { ok: false, error: 'Sign in first.' }
  }
  const r = await api('/account', { method: 'GET', bearer })
  if (r.status === 200 && isRecord(r.body) && Array.isArray(r.body.passkeys)) {
    return { ok: true, value: r.body as unknown as AccountInfo }
  }
  return { ok: false, error: politeError(r, 'Couldn’t load your account.') }
}

/** Asks the passkey to confirm it's really you (account deletion, removing a passkey). */
async function reauthProof(
  bearer: string,
): Promise<AuthResult<{ challengeId: string; response: unknown }>> {
  const r = await api('/auth/reauth/options', { bearer, body: '{}' })
  if (!isOptions(r.body)) {
    return { ok: false, error: politeError(r, 'Couldn’t start the check.') }
  }
  try {
    const response = await startAuthentication({
      optionsJSON: r.body.options as PublicKeyCredentialRequestOptionsJSON,
    })
    return { ok: true, value: { challengeId: r.body.challengeId, response } }
  } catch (err) {
    return ceremonyError(err)
  }
}

/** Adds another passkey (e.g. a second device). Confirms with an existing one if the session is old. */
export async function addPasskey(): Promise<AuthResult<PasskeyInfo[]>> {
  const bearer = await getAccessToken()
  if (!bearer) {
    return { ok: false, error: 'Sign in first.' }
  }
  let r = await api('/auth/passkeys/options', { bearer, body: '{}' })
  if (r.status === 403) {
    const proof = await reauthProof(bearer)
    if (!proof.ok) {
      return proof
    }
    r = await api('/auth/passkeys/options', {
      bearer,
      body: JSON.stringify({ proof: proof.value }),
    })
  }
  if (!isOptions(r.body)) {
    return { ok: false, error: politeError(r, 'Couldn’t start adding a passkey.') }
  }
  let response: unknown
  try {
    response = await startRegistration({
      optionsJSON: r.body.options as PublicKeyCredentialCreationOptionsJSON,
    })
  } catch (err) {
    return ceremonyError(err)
  }
  const done = await api('/auth/passkeys', {
    bearer,
    body: JSON.stringify({ challengeId: r.body.challengeId, response }),
  })
  if (done.status === 201 && isRecord(done.body) && Array.isArray(done.body.passkeys)) {
    return { ok: true, value: done.body.passkeys as PasskeyInfo[] }
  }
  return { ok: false, error: politeError(done, 'Couldn’t add that passkey.') }
}

/** Tells the passkey manager these credentials are gone, so they stop being offered. */
function forgetPasskeys(passkeys: readonly PasskeyInfo[], rpID: string): void {
  for (const p of passkeys) {
    void sendSignal({ signalName: 'unknownCredential', rpID, credentialID: p.id }).catch(
      () => undefined,
    )
  }
}

/**
 * Hard-deletes the account after a passkey confirmation: passkeys, sessions, wallet, inventory and
 * ghost. The name stays reserved for 30 days.
 */
export async function deleteAccount(): Promise<AuthResult<null>> {
  const bearer = await getAccessToken()
  if (!bearer) {
    return { ok: false, error: 'Sign in first.' }
  }
  const info = await accountInfo()
  const proof = await reauthProof(bearer)
  if (!proof.ok) {
    return proof
  }
  const r = await api('/account', {
    method: 'DELETE',
    bearer,
    body: JSON.stringify({ proof: proof.value }),
  })
  if (r.status !== 200) {
    return { ok: false, error: politeError(r, 'Couldn’t delete the account.') }
  }
  if (info.ok) {
    forgetPasskeys(info.value.passkeys, location.hostname)
  }
  setSession(null)
  return { ok: true, value: null }
}

/**
 * The app handoff page (`/out-west/auth/app?challenge&state&redirect_uri`): after the player
 * signs in here, mint a one-time code for the app and return to it.
 */
export async function handoffToApp(req: AppAuthorizeRequest): Promise<AuthResult<string>> {
  const bearer = await getAccessToken()
  if (!bearer) {
    return { ok: false, error: 'Sign in first.' }
  }
  const r = await api('/auth/app/authorize', { bearer, body: JSON.stringify(req) })
  if (r.status === 201 && isRecord(r.body) && typeof r.body.redirect === 'string') {
    return { ok: true, value: r.body.redirect }
  }
  return { ok: false, error: politeError(r, 'Couldn’t hand off to the app.') }
}
