/**
 * Shared by the flow end-to-end scripts (`flow-*-e2e.ts`): Chrome with a WebAuthn virtual
 * authenticator, the site and Worker under test, a tap counter, and a duel driver.
 *
 * Taps are counted in the page: every trusted `click` seen on `window` in the capture phase (menus
 * swallow their pointer events, never the click's capture). Keys pressed to walk and draw in a
 * duel are not taps. A flow asserts how many taps it took from one screen to the next.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/style/noPlaywrightWaitForSelector: the harness waits on the game's own DOM
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'

export const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
export const SITE = arg('--site', 'http://localhost:4400')
export const SHOTS = arg('--shots', join(import.meta.dir, '../.wrangler/flow-shots'))
export const OW = '/src/experiments/out-west'
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
mkdirSync(SHOTS, { recursive: true })

export interface Flow {
  browser: Browser
  context: BrowserContext
  page: Page
}

/** Chrome, a passkey authenticator, the socket's call watched, and the tap counter. */
export async function openFlow(viewport = { width: 1280, height: 800 }): Promise<Flow> {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('page error:', e.message))
  if (process.argv.includes('--verbose')) {
    page.on('console', (m) => console.log('console:', m.text()))
  }
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  })
  await context.addInitScript({
    content: `(() => {
      globalThis.__taps = 0
      addEventListener('click', (e) => { if (e.isTrusted) globalThis.__taps++ }, true)
      const Native = globalThis.WebSocket
      class Watched extends Native {
        constructor(url, protocols) {
          super(url, protocols)
          this.addEventListener('message', (e) => {
            if (typeof e.data === 'string' && e.data.includes('"type":"call"')) {
              const m = JSON.parse(e.data)
              globalThis.__owCallAt = performance.now() + (m.inMs ?? 0)
            }
          })
        }
      }
      globalThis.WebSocket = Watched
    })()`,
  })
  return { browser, context, page }
}

/** Zero the tap counter (the start of a measured stretch). */
export async function resetTaps(page: Page): Promise<void> {
  await page.evaluate('globalThis.__taps = 0')
}

/** Taps since the last reset. */
export async function taps(page: Page): Promise<number> {
  return Number(await page.evaluate('globalThis.__taps'))
}

/** Title → hub (one key press: the title's "press to start"). */
export async function toHub(page: Page, path = '/experiments/out-west/'): Promise<void> {
  await page.goto(`${SITE}${path}`)
  await page.waitForSelector('.ow-title.ready', { timeout: 90_000 })
  await page.keyboard.press('Space')
  await page.waitForSelector('.ow-hub.on', { timeout: 60_000 })
  await page.evaluate("document.querySelector('astro-dev-toolbar')?.remove()")
  await sleep(600)
}

/** Runs `body` in the page with the client's own module at `path` as `m`. */
export function inPage<T>(p: Page, path: string, body: string): Promise<T> {
  return p.evaluate(
    async ({ url, code }) => {
      const m: unknown = await import(url)
      // biome-ignore lint/security/noGlobalEval: the harness runs its own snippets in the page under test
      const run = globalThis.eval as (src: string) => (mod: unknown) => Promise<T>
      return await run(`(async (m) => { ${code} })`)(m)
    },
    { url: `${OW}/${path}`, code: body },
  )
}

/**
 * Walk (hold W) until the call, then fire `reactMs` after it (or before the bell when
 * `early`). The wait and the shot run inside the page, so harness latency never lands in it.
 */
export async function duel(
  page: Page,
  o: { reactMs?: number; early?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const { reactMs = 200, early = false, timeoutMs = 90_000 } = o
  await page.evaluate('globalThis.__owCallAt = 0')
  await page.keyboard.down('KeyW')
  try {
    await page.evaluate(`new Promise((resolve, reject) => {
      const t0 = performance.now()
      const key = (type, code) =>
        globalThis.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }))
      const fire = () => {
        key('keydown', 'Space')
        setTimeout(() => key('keyup', 'Space'), 40)
        resolve()
      }
      const watch = () => {
        const now = performance.now()
        const at = Number(globalThis.__owCallAt ?? 0)
        const shown = document.querySelector('.ow-call-indicator.on') !== null
        if (${early} && now - t0 > 2500) {
          // a draw key mid-walk is a back-shot: press until the street takes it (the poster and
          // the cock before the walk ignore it)
          if (document.querySelector('.ow-card-coward.on, .ow-card-lose.on, .ow-daily-result')) {
            key('keyup', 'KeyW')
            resolve()
            return
          }
          if (now - (globalThis.__owLastPress ?? 0) > 400) {
            globalThis.__owLastPress = now
            key('keydown', 'Space')
            setTimeout(() => key('keyup', 'Space'), 40)
          }
        }
        if (!${early} && (shown || (at > 0 && now >= at))) {
          key('keyup', 'KeyW')
          setTimeout(fire, ${reactMs})
          return
        }
        if (now - t0 > ${timeoutMs}) {
          reject(new Error('no call'))
          return
        }
        requestAnimationFrame(watch)
      }
      requestAnimationFrame(watch)
    })`)
  } finally {
    await page.keyboard.up('KeyW')
  }
}

let failures = 0
export function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) {
    failures++
  }
  console.log(
    `  ${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`,
  )
}

/** Assert a measured stretch took exactly `want` taps. */
export async function checkTaps(page: Page, what: string, want: number): Promise<void> {
  const n = await taps(page)
  check(`${what}: ${want} tap${want === 1 ? '' : 's'}`, n === want, { taps: n })
}

export async function shot(page: Page, name: string): Promise<void> {
  await sleep(300)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

export async function finish(f: Flow): Promise<never> {
  await f.browser.close()
  console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}
