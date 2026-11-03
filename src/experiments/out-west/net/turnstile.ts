/**
 * Cloudflare Turnstile, rendered on the title screen. It stays invisible unless
 * Cloudflare needs the player to interact. Never throws: no token means the
 * game simply plays in practice mode.
 */

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TEST_KEY = '1x00000000000000000000AA'
const TOKEN_TIMEOUT_MS = 15_000

const configured: unknown = import.meta.env.PUBLIC_TURNSTILE_SITEKEY
export const SITE_KEY = typeof configured === 'string' && configured ? configured : TEST_KEY

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id: string) => void
}

function api(): TurnstileApi | null {
  const t: unknown = Reflect.get(globalThis, 'turnstile')
  if (typeof t === 'object' && t !== null && 'render' in t && 'reset' in t) {
    return t as TurnstileApi
  }
  return null
}

let loading: Promise<TurnstileApi | null> | null = null

function load(): Promise<TurnstileApi | null> {
  loading ??= new Promise((resolve) => {
    const have = api()
    if (have) {
      resolve(have)
      return
    }
    const s = document.createElement('script')
    s.src = SCRIPT
    s.async = true
    s.addEventListener('load', () => resolve(api()))
    s.addEventListener('error', () => resolve(null))
    document.head.appendChild(s)
  })
  return loading
}

/** One widget, re-armed for each new ranked session (tokens are single-use). */
export class Turnstile {
  private readonly host: HTMLElement
  private widget = null as string | null
  private waiter = null as ((t: string | null) => void) | null
  private pending = null as Promise<string | null> | null

  constructor(parent: HTMLElement) {
    this.host = document.createElement('div')
    this.host.className = 'ow-turnstile'
    parent.appendChild(this.host)
  }

  /** Start fetching a token in the background (call on the title screen). */
  warm(): void {
    this.pending ??= this.get()
  }

  /** A fresh token, or null if Turnstile isn't available. */
  async take(): Promise<string | null> {
    const p = this.pending ?? this.get()
    this.pending = null
    return await p
  }

  private async get(): Promise<string | null> {
    const t = await load()
    if (!t) {
      return null
    }
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve(null)
      }, TOKEN_TIMEOUT_MS)
      this.waiter = (tok) => {
        clearTimeout(timer)
        this.waiter = null
        resolve(tok)
      }
      try {
        if (this.widget === null) {
          this.widget = t.render(this.host, {
            sitekey: SITE_KEY,
            appearance: 'interaction-only',
            callback: (tok: string) => this.waiter?.(tok),
            'error-callback': () => this.waiter?.(null),
            'expired-callback': () => {
              this.pending = null
            },
          })
        } else {
          t.reset(this.widget)
        }
      } catch {
        this.waiter?.(null)
      }
    })
  }
}
