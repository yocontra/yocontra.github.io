/**
 * Frontier, the 32-player free-for-all in Perdition. The hub (stream D) calls `mountFrontier` with
 * a full-screen root element; the dev page `/experiments/out-west/frontier/` calls it too.
 *
 *   const town = mountFrontier(root, { onExit: () => showHub() })
 *   await town.ready
 *   town.leave()    // the 5 s "Leave town" channel (banked in the bank, dropped elsewhere)
 *   town.destroy()  // immediate teardown (counts as a disconnect: the carry drops)
 *
 * `server: 'remote'` (the default) joins the real lobby: `POST /town/join` with the passkey
 * session, then the WebSocket. Refusals (`all_full`, `over_budget`, `unauthorized`, `unlicensed`)
 * show a friendly card and call `onExit('refused')`. `server: 'loopback'` plays against F's sim and
 * bots in a worker, with no account and no money at stake.
 */
import type { AudioEngine } from '../../audio/audio.ts'
import { FrontierGame } from './game.ts'
import type { FeedKind } from './hud.ts'
import {
  type JoinError,
  type LoopbackTransportOptions,
  openLoopback,
  openRemote,
} from './transport.ts'
import '../../ui/tokens.css'
import './frontier.css'
import './shooter.css'

export type FrontierExit = 'left' | 'quit' | 'lost' | 'refused'

export interface FrontierOptions {
  /** 'remote' joins the real lobby (default); 'loopback' runs the in-browser practice town. */
  server?: 'remote' | 'loopback'
  /** API base for `/town/join` (defaults to `PUBLIC_API_URL`). */
  apiUrl?: string
  /** Ask for a specific lobby ("Ride to a busier town", rejoin). */
  lobbyId?: string
  /** Server bots (dev only) or loopback bots (default 15). */
  bots?: number
  /** Loopback only: simulated one-way latency and jitter, ms. */
  lagMs?: number
  jitterMs?: number
  /** Loopback only: your name. */
  name?: string
  /** Loopback only (perf harness): the bots crowd around you and leave you be. */
  cluster?: boolean
  /** Loopback only (perf harness): the lobby's RNG seed, for repeatable runs. */
  seed?: number
  /** Loopback only (perf harness): where you first appear, layout metres. */
  spawn?: { x: number; z: number }
  /** Access token source for `/town/join` (defaults to the passkey session). */
  getToken?: () => Promise<string | null>
  /** Share the hub's audio engine (one AudioContext per page). */
  audio?: AudioEngine
  onExit?: (reason: FrontierExit, detail?: string) => void
}

export interface FrontierHandle {
  /** Resolves once the town is on screen. */
  readonly ready: Promise<void>
  leave: () => void
  destroy: () => void
  /** Perf and net numbers (also on `globalThis.__frontier` in dev builds). */
  debug: () => Record<string, unknown>
}

function overlay(root: HTMLElement): {
  el: HTMLElement
  progress: (f: number, label: string) => void
  refuse: (e: JoinError, onBack: () => void, onRetry: (() => void) | null) => void
  done: () => void
} {
  const el = document.createElement('div')
  el.className = 'fr-load fr-ui'
  const part = (cls: string, parent: HTMLElement = el, text = '') => {
    const d = document.createElement('div')
    d.className = cls
    d.textContent = text
    parent.append(d)
    return d
  }
  part('fr-load-title', el, 'PERDITION')
  part('fr-load-label')
  part('fr-load-fill', part('fr-load-bar'))
  part('fr-load-tip')
  root.append(el)
  const label = el.querySelector<HTMLElement>('.fr-load-label')
  const fill = el.querySelector<HTMLElement>('.fr-load-fill')
  const tip = el.querySelector<HTMLElement>('.fr-load-tip')
  if (tip) {
    const touch = matchMedia('(pointer: coarse)').matches
    tip.textContent = touch
      ? 'Left thumb moves, right thumb looks. Space jumps fences. Kill riders, grab their money, bank it before you die.'
      : 'WASD moves, the mouse looks, click fires, right-click aims. Space jumps fences. Kill riders, grab their money, bank it before you die.'
  }
  return {
    el,
    progress: (f, text) => {
      if (label) {
        label.textContent = text
      }
      if (fill) {
        fill.style.transform = `scaleX(${f})`
      }
    },
    refuse: (e, onBack, onRetry) => {
      el.classList.add('refused')
      el.innerHTML = ''
      const card = document.createElement('div')
      card.className = 'fr-refuse'
      const h = document.createElement('div')
      h.className = 'fr-load-title'
      const titles: Partial<Record<JoinError['reason'], string>> = {
        all_full: "TOWN'S FULL",
        over_budget: 'CLOSED FOR NOW',
      }
      h.textContent = titles[e.reason] ?? 'HOLD UP'
      const p = document.createElement('p')
      p.textContent = e.message
      card.append(h, p)
      if (onRetry) {
        // a full town, a blip, a failed check: worth another go, here and now
        const again = document.createElement('button')
        again.type = 'button'
        again.className = 'fr-menu-item fr-hit'
        again.textContent = e.reason === 'outdated' ? 'Refresh' : 'Try again'
        again.addEventListener('click', onRetry)
        card.append(again)
      }
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `fr-menu-item fr-hit${onRetry ? ' fr-menu-quiet' : ''}`
      b.textContent = onRetry ? 'Back' : 'Back to the saloon'
      b.addEventListener('click', onBack)
      card.append(b)
      el.append(card)
    },
    done: () => {
      el.classList.add('gone')
      setTimeout(() => el.remove(), 600)
    },
  }
}

/** The practice town's lobby options from the mount options. */
function loopbackOptions(opts: FrontierOptions): LoopbackTransportOptions {
  return {
    bots: opts.bots ?? 15,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.cluster ? { cluster: true } : {}),
    ...(opts.seed === undefined ? {} : { seed: opts.seed }),
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    lagMs: opts.lagMs ?? 0,
    jitterMs: opts.jitterMs ?? 0,
  }
}

/** Refusals worth another try in place (the rest need the saloon, or a refresh). */
const RETRY = new Set<JoinError['reason']>([
  'all_full',
  'network',
  'server',
  'turnstile',
  'outdated',
])

export function mountFrontier(root: HTMLElement, opts: FrontierOptions = {}): FrontierHandle {
  let destroyed = false
  const onExit = (reason: FrontierExit, detail?: string) => {
    opts.onExit?.(reason, detail)
  }
  /** Tear this town down and ride in again, in place (the handle keeps working). */
  const retry = (): void => {
    handle.destroy()
    const next = mountFrontier(root, opts)
    Object.assign(handle, next)
  }
  const retryFor = (reason: JoinError['reason']): (() => void) | null => {
    if (!RETRY.has(reason)) {
      return null
    }
    return reason === 'outdated' ? () => location.reload() : retry
  }
  const game = new FrontierGame(root, {
    ...(opts.audio ? { audio: opts.audio } : {}),
    onExit: (reason) => {
      if (reason === 'lost') {
        // the reconnect gave up: say so plainly, and offer another go
        lostCard()
        return
      }
      onExit(reason)
    },
  })
  const ui = overlay(root)
  const lostCard = (): void => {
    const card = overlay(root)
    card.refuse(
      { reason: 'network', message: "Connection lost. Couldn't reconnect." },
      () => onExit('lost'),
      retry,
    )
  }
  const unlock = () => game.unlockAudio()
  root.addEventListener('pointerup', unlock)
  globalThis.addEventListener('keydown', unlock)
  const ready = game
    .start(
      (ev) =>
        opts.server === 'loopback'
          ? openLoopback(loopbackOptions(opts), ev)
          : openRemote(
              {
                ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
                ...(opts.lobbyId ? { lobbyId: opts.lobbyId } : {}),
                ...(opts.getToken ? { getToken: opts.getToken } : {}),
                ...(opts.bots === undefined ? {} : { bots: opts.bots }),
                onRefused: (e) => {
                  ui.refuse(e, () => onExit('refused', e.reason), retryFor(e.reason))
                },
              },
              ev,
            ),
      ui.progress,
    )
    .then(() => {
      if (!(destroyed || ui.el.classList.contains('refused'))) {
        ui.done()
      }
    })
  const handle: FrontierHandle = {
    ready,
    leave: () => game.leave(),
    destroy: () => {
      if (destroyed) {
        return
      }
      destroyed = true
      root.removeEventListener('pointerup', unlock)
      globalThis.removeEventListener('keydown', unlock)
      ui.el.remove()
      game.dispose()
    },
    debug: () => game.debug(),
  }
  // Dev builds, or a perf-harness build (`PUBLIC_OW_PERF_HARNESS=1`, tools/frontier-perf.ts
  // --prod; never set for the real deploy), so both fold away in production.
  if (import.meta.env.DEV || import.meta.env.PUBLIC_OW_PERF_HARNESS === '1') {
    // Dev harness only: state for Playwright scripts (positions would be a wallhack in prod).
    Reflect.set(globalThis, '__frontier', () => game.debug())
    Reflect.set(globalThis, '__frontierTrace', {
      start: () => {
        Object.assign(game.net.corr, { smooth: 0, snap: 0, sumM: 0, maxM: 0 })
        game.trace.start()
      },
      stop: () => game.trace.stop(),
      corr: () => ({ ...game.net.corr }),
    })
    Reflect.set(globalThis, '__frontierFeed', (text: string, kind: FeedKind) =>
      game.hud.feed(text, kind),
    )
    // Dev harness: drive the shooter camera without pointer lock (headless can't lock).
    Reflect.set(globalThis, '__frontierView', {
      look: (dx: number, dy: number) => game.devLook(dx, dy),
      ads: (on: boolean) => game.devAds(on),
      set: (v: 'third' | 'first' | 'top') => game.setView(v),
      closeHowTo: () => game.devCloseHowTo(),
      weapon: (w: number | null) => game.devShowWeapon(w),
    })
  }
  const ap = game.autopilot
  if (import.meta.env.DEV && ap) {
    // Dev harness: drive this page from Playwright (see client/autopilot.ts).
    Reflect.set(globalThis, '__frontierPilot', {
      go: (x: number, z: number) => {
        const d = game.debug()
        return ap.go(Number(d.x), Number(d.z), x, z)
      },
      stop: () => ap.stop(),
      aimAt: (id: number) => ap.aimAt(id),
      aimPoint: (x: number, z: number) => ap.aimPoint(x, z),
      tap: (bit: number) => ap.tap(bit),
      hold: (bit: number, on: boolean) => ap.hold(bit, on),
      release: () => ap.release(),
      walking: () => ap.walking,
      stick: (mx: number, mz: number) => ap.stick(mx, mz),
    })
  }
  return handle
}
