/**
 * Player settings that live outside a run, per device: music and effects volume, vibration,
 * reduced motion and graphics quality. Stored under `ow.settings.v1` in localStorage, wrapped
 * (private windows and blocked storage fall back to the defaults and just don't remember).
 *
 *   getSettings()            the current values
 *   setSetting(key, value)   change one, persist, tell the listeners
 *   onSettings(cb)           listen (called with the new values); returns the unsubscribe
 *   reducedMotion()          the resolved flag: the player's choice, else the system's
 *   runFlag(k), setRunFlag   reduced motion, captions, mono audio and toggle walk
 *
 * Those four switches have one source of truth, the run's save (`save.ts` `settings`, which the
 * duel reads): `main.ts` binds them here with `bindRunFlags`. Until then reduced motion follows
 * `prefers-reduced-motion` and the rest read as their defaults (captions on).
 */

export type Graphics = 'auto' | 'low' | 'high'

export interface Settings {
  /** Music bus, 0..1. */
  music: number
  /** Effects bus (shots and the street; the bell ignores every slider), 0..1. */
  sfx: number
  /** Voices (barks, taunts, grunts), 0..1. */
  voice: number
  /** Buzz on your own shot and on a hit (never on the call). */
  vibration: boolean
  /**
   * iOS: play through the Ring/Silent switch. `true` sets the audio session to `playback`, so the
   * game is audible with the phone on silent (what every game expects); `false` keeps `ambient`.
   */
  silentAudio: boolean
  /** Renderer tier: auto picks by device; low and high force it. Applies on the next load. */
  graphics: Graphics
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  music: 0.8,
  sfx: 1,
  voice: 1,
  vibration: true,
  silentAudio: true,
  graphics: 'auto',
}

const KEY = 'ow.settings.v1'
const GRAPHICS: readonly Graphics[] = ['auto', 'low', 'high']

const unit = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d

function read(): Settings {
  let raw: unknown = null
  try {
    const s = localStorage.getItem(KEY)
    raw = s ? JSON.parse(s) : null
  } catch {
    // blocked storage or a smudged entry: the defaults
  }
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>
  return {
    music: unit(v.music, DEFAULT_SETTINGS.music),
    sfx: unit(v.sfx, DEFAULT_SETTINGS.sfx),
    voice: unit(v.voice, DEFAULT_SETTINGS.voice),
    vibration: typeof v.vibration === 'boolean' ? v.vibration : DEFAULT_SETTINGS.vibration,
    silentAudio: typeof v.silentAudio === 'boolean' ? v.silentAudio : DEFAULT_SETTINGS.silentAudio,
    graphics: GRAPHICS.includes(v.graphics as Graphics)
      ? (v.graphics as Graphics)
      : DEFAULT_SETTINGS.graphics,
  }
}

let current: Settings | null = null
const listeners = new Set<(s: Readonly<Settings>) => void>()

export function getSettings(): Readonly<Settings> {
  current ??= read()
  return current
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const next = { ...getSettings(), [key]: value }
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // private mode: this visit only
  }
  for (const cb of listeners) {
    cb(next)
  }
}

export function onSettings(cb: (s: Readonly<Settings>) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// --------------------------------------------------------------- the run save's switches

/** Switches kept in the run's save (`save.ts` `settings`) that the Settings sheet edits too. */
export type RunFlag = 'reducedMotion' | 'captions' | 'mono' | 'toggleWalk'

const systemReduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

let run: { get: (k: RunFlag) => boolean; set: (k: RunFlag, on: boolean) => void } | null = null

/** Hand the switches to the run's save (the one the duel reads). */
export function bindRunFlags(
  get: (k: RunFlag) => boolean,
  set: (k: RunFlag, on: boolean) => void,
): void {
  run = { get, set }
}

/** One switch; unbound, reduced motion follows the system and captions are on. */
export function runFlag(k: RunFlag): boolean {
  if (run) {
    return run.get(k)
  }
  if (k === 'reducedMotion') {
    return systemReduced()
  }
  return k === 'captions'
}

export function setRunFlag(k: RunFlag, on: boolean): void {
  run?.set(k, on)
  for (const cb of listeners) {
    cb(getSettings())
  }
}

/** Reduced motion, resolved: the player's setting, else the system preference. */
export function reducedMotion(): boolean {
  return runFlag('reducedMotion')
}
