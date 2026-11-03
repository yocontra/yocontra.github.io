import type { RunResult } from './data/economy.ts'
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

export function resetRun(data: SaveData, legend: boolean): void {
  data.level = 0
  data.legend = legend
  data.best = {}
  data.attempts = {}
  data.cowardice = 0
  data.assistUsed = data.settings.assist
  data.run = emptyRun()
}
