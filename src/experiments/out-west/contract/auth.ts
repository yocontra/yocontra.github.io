/**
 * HTTP and token types for accounts, passkeys and app handoff.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream A.
 *
 * Endpoints (all JSON; errors are `{ ok: false, error }` with a polite message):
 *
 * | Route                              | Auth            | Body → response                                   |
 * |------------------------------------|-----------------|---------------------------------------------------|
 * | `POST /auth/register/options`      | Turnstile       | `RegisterOptionsRequest` → `CeremonyOptions`      |
 * | `POST /auth/register/verify`       | ceremony        | `CeremonyVerify` → `AuthSession` (+ cookie)       |
 * | `POST /auth/login/options`         | none            | `{}` → `CeremonyOptions`                          |
 * | `POST /auth/login/verify`          | ceremony        | `CeremonyVerify` → `AuthSession` (+ cookie)       |
 * | `POST /auth/refresh`               | refresh token   | `RefreshRequest` → `AuthSession` (+ cookie)       |
 * | `POST /auth/logout`                | refresh token   | `RefreshRequest` → `{ ok: true }` (clears cookie) |
 * | `POST /auth/reauth/options`        | Bearer          | `{}` → `CeremonyOptions` (own passkeys only)      |
 * | `GET /auth/passkeys`               | Bearer          | → `PasskeyList`                                   |
 * | `POST /auth/passkeys/options`      | Bearer, recent  | `{}` → `CeremonyOptions`                          |
 * | `POST /auth/passkeys`              | Bearer, recent  | `CeremonyVerify` → `PasskeyList`                  |
 * | `DELETE /auth/passkeys/:id`        | Bearer, recent  | → `PasskeyList` (the last passkey can't go)       |
 * | `POST /auth/app/authorize`         | Bearer          | `AppAuthorizeRequest` → `AppAuthorizeResponse`    |
 * | `POST /auth/app/token`             | PKCE verifier   | `AppTokenRequest` → `AuthSession` with token      |
 * | `POST /tickets`                    | Bearer          | `TicketRequest` → `TicketResponse`                |
 * | `GET /account`                     | Bearer          | → `AccountInfo`                                   |
 * | `DELETE /account`                  | Bearer + reauth | `DeleteAccountRequest` → `{ ok: true }`           |
 *
 * "Recent" means the session's passkey ceremony happened within `REAUTH_WINDOW_MS`, or the body
 * carries a fresh reauth assertion (`ReauthProof`).
 */
export const CONTRACT_VERSION = 1

/** A signed-in gunslinger. `accountId` is the 16-byte base64url WebAuthn user handle. */
export interface Player {
  accountId: string
  name: string
}

/** Where a refresh token lives: an HttpOnly cookie on the web, the native secure store in the app. */
export type ClientPlatform = 'web' | 'ios-app' | 'android-app'
export const CLIENT_PLATFORMS: readonly ClientPlatform[] = ['web', 'ios-app', 'android-app']

/** What a WebSocket ticket is good for. */
export type TicketPurpose = 'duel' | 'town'
export const TICKET_PURPOSES: readonly TicketPurpose[] = ['duel', 'town']

/** Access tokens: HS256, held in memory only. */
export const ACCESS_TTL_MS = 15 * 60 * 1000
/** Refresh tokens rotate on every use; each new one lives this long. */
export const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000
/** WebSocket tickets: single use. */
export const TICKET_TTL_MS = 30 * 1000
/** App handoff codes: single use. */
export const APP_CODE_TTL_MS = 60 * 1000
/** WebAuthn challenges, and the name reservation made at registration options. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
/** Deleting the account or managing passkeys needs a passkey ceremony at most this old. */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000
/** A deleted account's name stays unavailable this long. */
export const NAME_RELEASE_MS = 30 * 24 * 60 * 60 * 1000

/** Header the web client sends on cookie endpoints (forces a CORS preflight; CSRF defence). */
export const CLIENT_HEADER = 'X-OW-Client'

/** Exact allowlist for the app handoff's `redirect_uri`. */
export const APP_REDIRECT_URIS: readonly string[] = [
  'outwest://auth/callback',
  'https://contra.io/out-west/app/callback',
]

/** Returned by every successful sign-in, sign-up, refresh and app token exchange. */
export interface AuthSession {
  accessToken: string
  /** Epoch ms when `accessToken` expires. */
  expiresAt: number
  player: Player
  /** Only for app platforms: the rotating refresh token for the native secure store. */
  refreshToken?: string
}

export interface RegisterOptionsRequest {
  name: string
  turnstileToken: string
}

/**
 * WebAuthn options for the browser. `options` is a `PublicKeyCredentialCreationOptionsJSON` or
 * `PublicKeyCredentialRequestOptionsJSON`; it stays `unknown` here so the contract has no imports.
 */
export interface CeremonyOptions {
  challengeId: string
  options: unknown
}

/** The browser's `RegistrationResponseJSON` or `AuthenticationResponseJSON` for a challenge. */
export interface CeremonyVerify {
  challengeId: string
  response: unknown
}

/** A fresh assertion from `POST /auth/reauth/options`. */
export type ReauthProof = CeremonyVerify

export interface RefreshRequest {
  /** App platforms only; the web sends the cookie instead. */
  refreshToken?: string
  platform?: ClientPlatform
}

export interface PasskeyInfo {
  id: string
  label: string | null
  createdAt: number
  lastUsedAt: number | null
  backedUp: boolean
}

export interface PasskeyList {
  passkeys: PasskeyInfo[]
}

export interface AccountInfo {
  player: Player
  createdAt: number
  passkeys: PasskeyInfo[]
}

export interface DeleteAccountRequest {
  proof?: ReauthProof
}

export type AppAuthPurpose = 'login' | 'register' | 'reauth'

export interface AppAuthorizeRequest {
  /** base64url(SHA-256(verifier)), 43 characters. */
  challenge: string
  /** Opaque value the app checks on return; echoed into the redirect. */
  state: string
  /** Must exactly match one of `APP_REDIRECT_URIS`. */
  redirect_uri: string
  purpose?: AppAuthPurpose
}

export interface AppAuthorizeResponse {
  code: string
  /** `redirect_uri?code=…&state=…`, ready for `location.replace`. */
  redirect: string
}

export interface AppTokenRequest {
  code: string
  verifier: string
  platform: Exclude<ClientPlatform, 'web'>
}

export interface TicketRequest {
  purpose: TicketPurpose
}

export interface TicketResponse {
  ticket: string
  expiresAt: number
}

/** The error body every endpoint uses. */
export interface ApiError {
  ok: false
  error: string
}
