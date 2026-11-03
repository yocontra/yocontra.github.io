/**
 * Cloudflare Turnstile. Every widget is `interaction-only`: invisible unless Cloudflare needs the
 * player to click. Never throws: no token means the caller's request is refused politely (ranked
 * plays in practice mode, a Frontier join shows the refusal card).
 *
 * Who spends tokens (§8): sign-up, the first web refresh of each UTC day (`net/auth.ts`), the
 * Bounty Hunt queue, ranked runs, and every Frontier lobby join. Tokens are single use.
 */

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TEST_KEY = '1x00000000000000000000AA'
const TOKEN_TIMEOUT_MS = 15_000

const configured: unknown = import.meta.env.PUBLIC_TURNSTILE_SITEKEY
/**
 * Production builds must provide `PUBLIC_TURNSTILE_SITEKEY` (CI enforces it). The always-pass test key
 * is only ever used in dev; a production build without a key gets none, so verification fails closed.
 */
const DEV_FALLBACK = import.meta.env.DEV ? TEST_KEY : ''
export const SITE_KEY = typeof configured === 'string' && configured ? configured : DEV_FALLBACK

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

/**
 * One widget, re-armed for each token (tokens are single use). Requests are served one at a time,
 * so two callers sharing a widget (a refresh and a lobby join) never steal each other's token.
 */
export class Turnstile {
  private readonly host: HTMLElement
  private widget = null as string | null
  private waiter = null as ((t: string | null) => void) | null
  private pending = null as Promise<string | null> | null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(parent: HTMLElement) {
    this.host = document.createElement('div')
    this.host.className = 'ow-turnstile'
    if (parent === document.body) {
      // Page-level widget (any page, styled or not): pinned above the game in case Cloudflare
      // asks for a click; empty and invisible otherwise.
      Object.assign(this.host.style, {
        position: 'fixed',
        left: '50%',
        bottom: 'max(48px, calc(env(safe-area-inset-bottom) + 40px))',
        translate: '-50% 0',
        zIndex: '1000',
      })
    }
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

  private get(): Promise<string | null> {
    const next = this.queue.then(() => this.issue())
    this.queue = next.catch(() => null)
    return next
  }

  private async issue(): Promise<string | null> {
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

let shared: Turnstile | null = null

/** The page's shared widget (on `document.body`), made on first use. */
export function pageTurnstile(): Turnstile {
  shared ??= new Turnstile(document.body)
  return shared
}
