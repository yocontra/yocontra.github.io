import { AudioEngine } from './audio/audio.ts'
import { startupFailure } from './client/startup-error.ts'
import { OUTLAWS } from './data/outlaws.ts'
import type { NativeRankedConnect as RankedConnect } from './duel/native-director.ts'

import type { Game } from './game.ts'
import { Meta } from './meta/progress.ts'
import { restoreSession } from './net/auth.ts'
import { RankedSession } from './net/ranked.ts'
import { Turnstile } from './net/turnstile.ts'
import { setAudioSessionMode, unlockAudio } from './platform/audio.ts'
import { installDevice } from './platform/device.ts'
import { installGamepad } from './platform/gamepad.ts'
import { setHapticsEnabled } from './platform/haptics.ts'
import { pickTier } from './platform/render-tier.ts'
import { registerServiceWorker } from './platform/sw.ts'
import { installViewportVars } from './platform/viewport.ts'
import { load, type SaveData, save } from './save.ts'
import { DRAW_SOUNDS } from './scene/draw-sounds.ts'
import { bindRunFlags, getSettings, onSettings, type Settings } from './settings.ts'
import { Board, lastBoardTab } from './ui/board.ts'
import { installGazette } from './ui/gazette.ts'
import { Hub } from './ui/hub.ts'
import { hubMeta } from './ui/meta-hub.ts'
import { loadPosterArt } from './ui/poster.ts'
import { installUiSounds } from './ui/sfx.ts'
import { installTitleInput } from './ui/title-input.ts'
import { Toaster } from './ui/toast.ts'

/** Hashes that jump into a debug view or a non-default run: never ranked. */
const UNRANKED_HASHES = ['level', 'legend', 'lineup', 'posters']

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
  // Warm on the first gesture (the title press), not at load: a cold look at the page (a crawler,
  // a visitor who never presses) loads no Turnstile iframe and none of its console noise, and the
  // title, hub and Quick Draw sheet still give the token seconds to arrive before a ranked run.
  const warm = (): void => {
    globalThis.removeEventListener('pointerdown', warm, true)
    globalThis.removeEventListener('keydown', warm, true)
    turnstile.warm()
  }
  globalThis.addEventListener('pointerdown', warm, true)
  globalThis.addEventListener('keydown', warm, true)
  return async () => {
    const token = await turnstile.take()
    if (!token) {
      // never a dead end: the run plays on in practice, and a restart asks again
      return {
        ok: false,
        error: 'Couldn’t verify this device, so this run is practice. Restart to try ranked again.',
      }
    }
    return await RankedSession.connect(token)
  }
}

/** Credits and leaderboard buttons on the title; their clicks never start the game. */
function wireTitleLinks(root: HTMLElement, title: HTMLElement): void {
  const credits = root.querySelector<HTMLElement>('.ow-credits')
  const creditsButton = root.querySelector('.ow-credits-btn')
  const showCredits = (open: boolean) => {
    credits?.classList.toggle('on', open)
    creditsButton?.setAttribute('aria-expanded', String(open))
    if (open) {
      credits?.querySelector<HTMLButtonElement>('.ow-credits-close')?.focus()
    }
  }
  creditsButton?.addEventListener('click', (e) => {
    e.stopPropagation()
    showCredits(!credits?.classList.contains('on'))
  })
  const closeCredits = () => {
    showCredits(false)
    if (creditsButton instanceof HTMLElement) {
      creditsButton.focus()
    }
  }
  credits?.querySelector('.ow-credits-close')?.addEventListener('click', closeCredits)
  title.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && credits?.classList.contains('on')) {
      e.stopPropagation()
      closeCredits()
    }
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

/** The queue spends its own Turnstile tokens (one per search), apart from ranked runs'. */
function queueTokens(root: HTMLElement): () => Promise<string | null> {
  let t: Turnstile | null = null
  return () => {
    t ??= new Turnstile(root)
    t.warm()
    return t.take()
  }
}

/**
 * The phases where nothing may pop up: from the cocking through the kill cam and its result card
 * (the card is up for the whole of win / lose / coward). Held toasts come out once the card is
 * dismissed, or at the hub.
 */
const QUIET_PHASES = new Set([
  'cock',
  'walk',
  'turn',
  'wait',
  'call',
  'win',
  'lose',
  'coward',
  'bossClock',
  'bossWound',
])

/** The meta-game: medals, the guest purse, achievements' toasts, the Gazette between duels. */
function makeMeta(root: HTMLElement, data: SaveData, game: () => Game | null): Meta {
  // the HUD writes the phase on the root (hud.phase); a pause menu or a result card holds them too
  const toaster = new Toaster(
    root,
    () =>
      QUIET_PHASES.has(root.dataset.duel ?? '') ||
      root.querySelector('.ow-menu.on, .ow-card.on') !== null,
  )
  const meta = new Meta({
    save: () => game()?.director.c.save ?? data,
    runId: () => game()?.rankedRunId() ?? null,
    toast: (t) => toaster.push(t),
  })
  installGazette(root, meta)
  return meta
}

/** The saloon hub between the title and every mode. */
function makeHub(
  root: HTMLElement,
  o: { data: SaveData; rankedOk: boolean; game: () => Game | null; meta: Meta; audio: AudioEngine },
): Hub {
  const { data, rankedOk, game, meta, audio } = o
  let board: Board | null = null
  const dailyTokens = queueTokens(root)
  const hub: Hub = new Hub(root, {
    meta: hubMeta(root, meta, {
      ready: () => game() !== null,
      token: dailyTokens,
      start: (spec, session, back) => {
        const g = game()
        if (!g) {
          session.close()
          return
        }
        hub.hide()
        // the result sheet comes up on the empty street: another try, or `home`
        g.playDaily({ spec, session, onExit: back })
      },
      home: () => hub.show(),
    }),
    ready: () => game() !== null,
    continueAt: () => data.level,
    rankedOk,
    stage: (shot) => game()?.hubShot(shot),
    dress: (l, dyes) => game()?.dress(l, dyes),
    thumb: (id) => game()?.itemThumb(id) ?? null,
    previewSound: (id) => {
      if (!id.startsWith('sound.')) {
        return
      }
      const s = DRAW_SOUNDS[id] ?? { rate: 1, gain: 0.7 }
      audio.play('fireBig', { gain: s.gain, rate: s.rate, reverb: 0.8 })
      if (s.hawk) {
        audio.play('hawk', { gain: 0.5, when: audio.now + 0.35 })
      }
    },
    playGauntlet: (c) => game()?.playGauntlet(c),
    bountyHunt: (match, xpBefore) =>
      game()?.startPvp({
        wsUrl: match.wsUrl,
        opponent: match.opponent,
        xpBefore,
        purse: hub.profile?.purse ?? null,
        refreshXp: async () => {
          await hub.refresh()
          return hub.profile?.xp ?? null
        },
        onExit: (how) => (how === 'next' ? hub.requeue() : hub.show()),
      }),
    token: queueTokens(root),
    openBoard: () => {
      board ??= new Board(root)
      board.open({ tab: lastBoardTab('most-wanted') })
    },
  })
  return hub
}

/** The volume API the audio engine grows (audio-content); a no-op until it lands. */
interface Volumes {
  setMusicVolume?: (v: number) => void
  setSfxVolume?: (v: number) => void
  setVoiceVolume?: (v: number) => void
  setVoiceChatVolume?: (v: number) => void
}

/**
 * The Settings sheet's choices, applied: volumes to the audio engine, vibration to the haptics
 * gate, and reduced motion, captions, mono audio and toggle walk bound to the run's save (the duel
 * reads them there); reduced motion is also a root class the CSS honours like the system's.
 */
function wireSettings(
  root: HTMLElement,
  audio: AudioEngine,
  data: SaveData,
  game: () => Game | null,
): void {
  const apply = (s: Readonly<Settings>): void => {
    const v = audio as AudioEngine & Volumes
    v.setMusicVolume?.(s.music)
    v.setSfxVolume?.(s.sfx)
    v.setVoiceVolume?.(s.voice)
    v.setVoiceChatVolume?.(s.voiceChatVolume)
    setHapticsEnabled(s.vibration)
    // iOS: `playback` keeps the game audible with the Ring/Silent switch on; `ambient` respects it.
    setAudioSessionMode(s.silentAudio ? 'playback' : 'ambient')
    root.classList.toggle('ow-reduced', data.settings.reducedMotion)
  }
  bindRunFlags(
    (k) => data.settings[k],
    (k, on) => {
      data.settings[k] = on
      save(data)
      const g = game()
      if (g) {
        g.director.applySettings()
      }
    },
  )
  apply(getSettings())
  onSettings(apply)
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
 * Entry point. Kept tiny so the title broadside is interactive immediately; the
 * native game streams in behind it via a dynamic import.
 */
export function boot(root: HTMLElement): void {
  registerServiceWorker()
  const audio = new AudioEngine()
  audio.prefetch()
  installUiSounds(audio)
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
  if (!(canvas && title && startText)) {
    return
  }
  wireTitleLinks(root, title)
  const connectRanked = rankedConnector(root, hash)

  let game: Game | null = null
  let pressed = false
  let started = false
  // a level jump (#level=N) or a debug view skips the hub, as before
  const meta = makeMeta(root, data, () => game)
  const hub =
    jump || debug
      ? null
      : makeHub(root, {
          data,
          rankedOk: connectRanked !== null,
          game: () => game,
          meta,
          audio,
        })
  wireSettings(root, audio, data, () => game)
  installViewportVars()
  // form factor, fold/unfold, late WebKit resizes, the pinch guard; then pads and menu arrows
  installDevice()
  installGamepad()
  // a silent refresh from the cookie: the hub shows your poster if you're signed in
  restoreSession()
    .then(() => Promise.all([hub?.refresh(), meta.sync()]))
    .catch(() => undefined)

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
    const g = game
    // The scene warms one program per frame behind the title (game.ts / render.ts). Show the hub
    // when it is ready; do not freeze the page waiting for every shader at once.
    void (async () => {
      try {
        await g.whenWarm()
      } catch {
        // a driver failure must not strand the title: the first frame will report it
      }
      // The scene is warm; decode the rest of the sounds while the player is in the hub.
      void audio.loadPacks()
      title.classList.add('wipe')
      setTimeout(() => title.remove(), 1100)
      if (hub) {
        hub.show()
      } else {
        g.begin(jump)
      }
    })()
  }

  let stopTitleInput: () => void = () => undefined
  const press = () => {
    if (pressed) {
      return
    }
    stopTitleInput()
    pressed = true
    // Set the iOS session before the context is created: switching it afterwards can interrupt
    // the first sound. `playback` (the default) is audible with the Ring/Silent switch on.
    const mode = getSettings().silentAudio ? 'playback' : 'ambient'
    setAudioSessionMode(mode)
    audio.unlock()
    if (audio.ctx) {
      // iOS: resume after calls and Siri, suspend when hidden
      unlockAudio(audio.ctx, { mode })
    }
    audio.playSong(data.level >= 15 ? 'boss' : 'intro')
    title.classList.add('pressed')
    if (startText) {
      startText.textContent = 'Loading…'
      startText.setAttribute('aria-busy', 'true')
    }
    go()
  }
  stopTitleInput = installTitleInput(title, startText, press)

  // Back from Frontier: straight to the saloon, no title screen. Audio unlocks on the first tap.
  if (hub && new URLSearchParams(location.search).has('saloon')) {
    pressed = true
    stopTitleInput()
    history.replaceState(null, '', location.pathname + location.hash)
    let unlocked = false
    const unlockOnce = () => {
      if (unlocked) {
        return
      }
      unlocked = true
      const mode = getSettings().silentAudio ? 'playback' : 'ambient'
      setAudioSessionMode(mode)
      audio.unlock()
      if (audio.ctx) {
        unlockAudio(audio.ctx, { mode })
      }
      audio.playSong('saloon')
      globalThis.removeEventListener('pointerdown', unlockOnce)
      globalThis.removeEventListener('touchend', unlockOnce)
    }
    globalThis.addEventListener('pointerdown', unlockOnce, { once: true })
    globalThis.addEventListener('touchend', unlockOnce, { once: true })
  }

  // the wanted posters are painted on canvas, which never swaps in a late font: fonts and stock first
  Promise.all([import('./game.ts'), loadPosterArt()])
    .then(([m]) =>
      m.createGame({
        root,
        canvas,
        audio,
        save: data,
        debug,
        tier,
        onProgress: setProgress,
        connectRanked,
        onSaloon: hub ? () => hub.show() : null,
      }),
    )
    .then((g) => {
      game = g
      globalThis.addEventListener('pagehide', (event) => {
        // A bfcache entry resumes this same engine and its suspended match connection.
        if (!event.persisted) {
          g.destroy()
        }
      })
      if (import.meta.env.DEV && debug) {
        Reflect.set(globalThis, '__ow', g)
      }
      if (hash.has('lineup') || hash.has('posters')) {
        stopTitleInput()
        // debug views draw the scene: run them once it is warm, not on a cold first frame
        void (async () => {
          try {
            await g.whenWarm()
          } catch {
            // draw anyway
          }
          debugView(g, hash, title)
        })()
        return
      }
      hub?.gameReady()
      title.classList.add('ready')
      if (pressed) {
        go()
      }
    })
    .catch((error: unknown) => {
      stopTitleInput()
      game?.destroy()
      game = null
      title.classList.remove('ready', 'pressed', 'wipe')
      startText.removeAttribute('aria-busy')
      startText.textContent = 'Retry loading'
      if (loading) {
        loading.textContent = startupFailure(error)
      }
      startText.addEventListener('click', () => location.reload(), { once: true })
    })
}
