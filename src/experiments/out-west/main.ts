import { AudioEngine } from './audio/audio.ts'
import { OUTLAWS } from './data/outlaws.ts'
import type { RankedConnect } from './duel/director.ts'
import type { Tier } from './engine/render.ts'
import type { Game } from './game.ts'
import { RankedSession } from './net/ranked.ts'
import { Turnstile } from './net/turnstile.ts'
import { load, type SaveData, save } from './save.ts'
import { Board } from './ui/board.ts'

/** Hashes that jump into a debug view or a non-default run: never ranked. */
const UNRANKED_HASHES = ['level', 'legend', 'lineup', 'posters']
const START_KEYS = ['Space', 'Enter', 'KeyJ', 'KeyW', 'ArrowUp', 'ArrowLeft']

function pickTier(param: string | null): Tier {
  if (param === 'low' || param === 'high') {
    return param
  }
  const coarse = matchMedia('(pointer: coarse)').matches
  const small = Math.min(screen.width, screen.height) < 700
  return coarse || small ? 'low' : 'high'
}

/** `#level=N` jumps straight to outlaw N; returns true when it did. */
function applyLevelJump(data: SaveData, param: string | null): boolean {
  if (!param) {
    return false
  }
  const n = Number.parseInt(param, 10)
  if (!Number.isFinite(n)) {
    return false
  }
  data.level = Math.min(OUTLAWS.length, Math.max(1, n)) - 1
  data.seenIntro = true
  save(data)
  return true
}

/**
 * Ranked play: a Turnstile widget armed on the title screen, and a connector
 * that spends one fresh token per ranked session (a restart asks again).
 * Null when this page load can't be ranked.
 */
function rankedConnector(root: HTMLElement, hash: URLSearchParams): RankedConnect | null {
  if (UNRANKED_HASHES.some((h) => hash.has(h))) {
    return null
  }
  // on the root, not the title: the title is wiped, and later runs re-arm this widget
  const turnstile = new Turnstile(root)
  turnstile.warm()
  return async () => {
    const token = await turnstile.take()
    if (!token) {
      return null
    }
    const session = await RankedSession.connect(token)
    return session.ok ? session.value : null
  }
}

/** Credits and leaderboard buttons on the title; their clicks never start the game. */
function wireTitleLinks(root: HTMLElement, title: HTMLElement): void {
  const credits = root.querySelector<HTMLElement>('.ow-credits')
  root.querySelector('.ow-credits-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    credits?.classList.toggle('on')
  })
  let board: Board | null = null
  root.querySelector('.ow-board-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    board ??= new Board(root)
    board.open()
  })
  for (const a of title.querySelectorAll('a, button, .ow-credits')) {
    a.addEventListener('pointerdown', (e) => e.stopPropagation())
  }
}

/** Debug views that replace the title entirely. Returns true when one ran. */
function debugView(g: Game, hash: URLSearchParams, title: HTMLElement): boolean {
  if (!(hash.has('lineup') || hash.has('posters'))) {
    return false
  }
  title.remove()
  if (hash.has('lineup')) {
    g.director.lineup(Number(hash.get('day') ?? '0.3')).catch(() => undefined)
  }
  if (hash.has('posters')) {
    g.director.posters().catch(() => undefined)
  }
  return true
}

/**
 * Entry point. Kept tiny so the red title is interactive immediately; the
 * three.js game streams in behind it via a dynamic import.
 */
export function boot(root: HTMLElement): void {
  const audio = new AudioEngine()
  audio.prefetch()
  const data = load()
  const hash = new URLSearchParams(location.hash.slice(1))
  const debug = hash.has('debug')
  globalThis.addEventListener('hashchange', () => location.reload())
  const jump = applyLevelJump(data, hash.get('level'))
  if (hash.has('legend')) {
    data.legend = true
  }
  const tier = pickTier(hash.get('tier'))

  const canvas = root.querySelector<HTMLCanvasElement>('canvas.ow-canvas')
  const title = root.querySelector<HTMLElement>('.ow-title')
  const loading = root.querySelector<HTMLElement>('.ow-loading')
  const startText = root.querySelector<HTMLElement>('.ow-start')
  if (!(canvas && title)) {
    return
  }
  wireTitleLinks(root, title)
  const connectRanked = rankedConnector(root, hash)

  let game: Game | null = null
  let pressed = false
  let started = false

  const setProgress = (f: number) => {
    if (loading) {
      loading.textContent = f >= 1 ? '' : `loading ${Math.round(f * 100)}%`
    }
  }

  const go = () => {
    if (started || !game) {
      return
    }
    started = true
    title.classList.add('wipe')
    setTimeout(() => title.remove(), 1100)
    const g = game
    // Everything is decoded before the first duel; nothing decodes mid-duel.
    audio
      .whenDecoded()
      .then(() => g.begin(jump))
      .catch(() => undefined)
  }

  const press = (e: Event) => {
    if (pressed) {
      return
    }
    if (e instanceof KeyboardEvent) {
      if (!START_KEYS.includes(e.code)) {
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    pressed = true
    audio.unlock()
    audio.playSong(data.level >= 15 ? 'boss' : 'intro')
    title.classList.add('pressed')
    if (startText) {
      startText.textContent = game ? '' : 'saddling up…'
    }
    go()
  }
  title.addEventListener('pointerdown', press)
  globalThis.addEventListener('keydown', press)

  import('./game.ts')
    .then((m) =>
      m.createGame({
        root,
        canvas,
        audio,
        save: data,
        debug,
        tier,
        onProgress: setProgress,
        connectRanked,
      }),
    )
    .then((g) => {
      game = g
      if (debug) {
        Reflect.set(globalThis, '__ow', g)
      }
      if (debugView(g, hash, title)) {
        return
      }
      title.classList.add('ready')
      if (startText && pressed) {
        startText.textContent = ''
      }
      if (pressed) {
        go()
      }
    })
    .catch(() => {
      if (loading) {
        loading.textContent = 'This needs WebGL2. Try the 2019 original below.'
      }
    })
}
