import type { RunResult } from './data/economy.ts'
import { emptyMark, OUTLAW_COUNT, type OutlawMark } from './data/medals.ts'
import { DEFAULT_KEYS, type KeyMap } from './engine/input.ts'

export interface Best {
  ms: number
  grade: string
  attempts: number
}

export interface Settings {
  reducedMotion: boolean
  captions: boolean
  toggleWalk: boolean
  assist: boolean
  mono: boolean
  keys: KeyMap
}

export interface SaveData {
  version: 1
  level: number
  legend: boolean
  legendUnlocked: boolean
  seenIntro: boolean
  seenPosters: number[]
  best: Record<number, Best>
  attempts: Record<number, number>
  cowardice: number
  assistUsed: boolean
  settings: Settings
  /** The gauntlet in progress: every duel and the purse (leaderboard-ready). */
  run: RunResult
  /** Best finished purse on this device. */
  bestTotal: number
}

export function emptyRun(): RunResult {
  return { version: 1, duels: [], total: 0 }
}

const KEY = 'out-west-3d'

function defaults(): SaveData {
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return {
    version: 1,
    level: 0,
    legend: false,
    legendUnlocked: false,
    seenIntro: false,
    seenPosters: [],
    best: {},
    attempts: {},
    cowardice: 0,
    assistUsed: false,
    settings: {
      reducedMotion: reduced,
      captions: true,
      toggleWalk: false,
      assist: false,
      mono: false,
      keys: structuredClone(DEFAULT_KEYS),
    },
    run: emptyRun(),
    bestTotal: 0,
  }
}

export function load(): SaveData {
  const d = defaults()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return d
    }
    const parsed = JSON.parse(raw) as Partial<SaveData>
    if (parsed.version !== 1) {
      return d
    }
    const run = parsed.run
    const okRun =
      run && run.version === 1 && Array.isArray(run.duels) && typeof run.total === 'number'
    return {
      ...d,
      ...parsed,
      run: okRun ? run : emptyRun(),
      bestTotal: typeof parsed.bestTotal === 'number' ? parsed.bestTotal : 0,
      settings: {
        ...d.settings,
        ...(parsed.settings ?? {}),
        keys: { ...d.settings.keys, ...(parsed.settings?.keys ?? {}) },
      },
    }
  } catch {
    return d
  }
}

export function save(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // Private mode or storage full: progress just won't persist.
  }
}

// ─── The solo meta-game (medals, the guest purse, achievements) ──────────────────────────────────

/**
 * Device progress for the meta-game, kept under its own key so a duel's scratch save (Bounty Hunt,
 * the Daily Outlaw) can never overwrite it. Marks earned here are the guest purse
 * (`guestCredit` in data/medals.ts), which migrates into an account once, server-capped.
 */
export interface MetaSave {
  version: 1
  /** Per outlaw (gauntlet slot): best medal tier, best counted ms, challenge done. */
  marks: OutlawMark[]
  /** Outlaws beaten on this device (17-bit mask): the guest purse's first clears. */
  clears: number
  /** Most outlaws beaten in one Legend run. */
  legendBest: number
  /** Achievement id → when it was unlocked (epoch ms). */
  achievements: Record<string, number>
  /** Counters the achievements read. */
  stats: {
    wins: number
    hats: number
    fakesBeaten: number
    /** UTC days with a Daily Outlaw win. */
    dailyDays: string[]
    /** Gazette front pages read (outlaw slots), and the epilogue. */
    gazette: number[]
    epilogue: boolean
    signedIn: boolean
    /** One-off moments for achievements (`lightning`, `stubborn`, `clean-clear`). */
    moments: string[]
  }
  /** Accounts this device's guest purse already migrated into. */
  migrated: string[]
}

const META_KEY = 'out-west-meta'

export function emptyMeta(): MetaSave {
  return {
    version: 1,
    marks: Array.from({ length: OUTLAW_COUNT }, emptyMark),
    clears: 0,
    legendBest: 0,
    achievements: {},
    stats: {
      wins: 0,
      hats: 0,
      fakesBeaten: 0,
      dailyDays: [],
      gazette: [],
      epilogue: false,
      signedIn: false,
      moments: [],
    },
    migrated: [],
  }
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Reads the device's meta save; anything missing or smudged falls back to empty. */
export function loadMeta(): MetaSave {
  const d = emptyMeta()
  try {
    const raw = localStorage.getItem(META_KEY)
    const p = raw ? (JSON.parse(raw) as Partial<MetaSave>) : null
    if (!p || p.version !== 1) {
      return d
    }
    const marks = d.marks.map((m, i) => {
      const x = Array.isArray(p.marks) ? (p.marks[i] as Partial<OutlawMark> | undefined) : undefined
      return {
        tier: Math.min(3, Math.max(0, Math.floor(num(x?.tier)))) as OutlawMark['tier'],
        bestMs: typeof x?.bestMs === 'number' ? x.bestMs : m.bestMs,
        challenge: x?.challenge === true,
      }
    })
    const s = (p.stats ?? {}) as Partial<MetaSave['stats']>
    return {
      version: 1,
      marks,
      clears: Math.floor(num(p.clears)),
      legendBest: Math.floor(num(p.legendBest)),
      achievements:
        typeof p.achievements === 'object' && p.achievements !== null ? p.achievements : {},
      stats: {
        wins: num(s.wins),
        hats: num(s.hats),
        fakesBeaten: num(s.fakesBeaten),
        dailyDays: Array.isArray(s.dailyDays) ? s.dailyDays.filter((x) => typeof x === 'string') : [],
        gazette: Array.isArray(s.gazette) ? s.gazette.filter((x) => typeof x === 'number') : [],
        epilogue: s.epilogue === true,
        signedIn: s.signedIn === true,
        moments: Array.isArray(s.moments) ? s.moments.filter((x) => typeof x === 'string') : [],
      },
      migrated: Array.isArray(p.migrated) ? p.migrated.filter((x) => typeof x === 'string') : [],
    }
  } catch {
    return d
  }
}

export function saveMeta(m: MetaSave): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m))
  } catch {
    // private mode: medals just won't persist on this device
  }
}

export function resetRun(data: SaveData, legend: boolean): void {
  data.level = 0
  data.legend = legend
  data.best = {}
  data.attempts = {}
  data.cowardice = 0
  data.assistUsed = data.settings.assist
  data.run = emptyRun()
}
