/**
 * Player settings that live outside a run, per device: music and effects volume, vibration,
 * reduced motion and graphics quality. Stored under `ow.settings.v1` in localStorage, wrapped
 * (private windows and blocked storage fall back to the defaults and just don't remember).
 *
 *   getSettings()            the current values
 *   setSetting(key, value)   change one, persist, tell the listeners
 *   onSettings(cb)           listen (called with the new values); returns the unsubscribe
 *   reducedMotion()          the resolved flag: the player's choice, else the system's
 *
 * Reduced motion has one source of truth, the run's save (`save.ts` `settings.reducedMotion`,
 * which the pause menu toggles too): `main.ts` binds it here with `bindReducedMotion`. Until
 * then it follows `prefers-reduced-motion`.
 */

export type Graphics = 'auto' | 'low' | 'high'

export interface Settings {
  /** Music bus, 0..1. */
  music: number
  /** Effects bus (shots, the bell, the street), 0..1. */
  sfx: number
  /** Buzz on your own shot and on a hit (never on the call). */
  vibration: boolean
  /** Renderer tier: auto picks by device; low and high force it. Applies on the next load. */
  graphics: Graphics
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  music: 0.8,
  sfx: 1,
  vibration: true,
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
    vibration: typeof v.vibration === 'boolean' ? v.vibration : DEFAULT_SETTINGS.vibration,
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

// ------------------------------------------------------------------------------ reduced motion

const systemReduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

let motion: { get: () => boolean; set: (on: boolean) => void } | null = null

/** Hand reduced motion to the run's save (the one the pause menu edits). */
export function bindReducedMotion(get: () => boolean, set: (on: boolean) => void): void {
  motion = { get, set }
}

/** Reduced motion, resolved: the player's setting, else the system preference. */
export function reducedMotion(): boolean {
  return motion ? motion.get() : systemReduced()
}

export function setReducedMotion(on: boolean): void {
  motion?.set(on)
  for (const cb of listeners) {
    cb(getSettings())
  }
}
