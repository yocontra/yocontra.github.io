/**
 * The Daily Outlaw: one seeded duel per UTC day, the same for everyone, with a modifier or two.
 * Pure: shared by the client (the hub tile, the duel's presentation) and the Worker (the
 * DailySession's tuning and the board). Owned by the meta-game stream.
 *
 * The spec is public (who, how fast, which modifiers). The wait and the fake-outs' timing are
 * drawn by the server per attempt and never sent early, exactly like a ranked duel.
 */

export const DAILY_VERSION = 1

export const DAILY_MODIFIERS = ['fog', 'double-fakes', 'no-bell'] as const
export type DailyModifier = (typeof DAILY_MODIFIERS)[number]

/** Attempts per account (or device) per UTC day. Your best win is your board time. */
export const DAILY_ATTEMPTS = 3
/** A win on the day pays once: 75 XP and $50 (signed in, through the ledger). */
export const DAILY_PAY = { xp: 75, cash: 50 } as const
/** The board shows this many. */
export const DAILY_BOARD_SIZE = 20

export interface DailySpec {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  /** The outlaw he borrows his look and lines from (index into OUTLAWS). */
  outlaw: number
  /** His draw after the call, ms, and the ± jitter. */
  drawMs: number
  jitterMs: number
  accuracy: number
  /** The wait before the call, ms. */
  waitMs: readonly [number, number]
  /** Fake-out cues fired during the wait (exactly this many). */
  fakes: number
  /** The cue pool the server picks from (names the client already plays). */
  cues: readonly string[]
  modifiers: readonly DailyModifier[]
  /** Headline for the hub tile and the Gazette. */
  title: string
  /** One line: what's different today. */
  blurb: string
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u

export const dayKey = (now: number = Date.now()): string => new Date(now).toISOString().slice(0, 10)

export const isDayKey = (s: unknown): s is string =>
  typeof s === 'string' && DAY_RE.test(s) && dayKey(Date.parse(`${s}T00:00:00Z`)) === s

/** Epoch ms when `day` ends (the next UTC midnight). */
export const dayEnds = (day: string): number => Date.parse(`${day}T00:00:00Z`) + 86_400_000

/** FNV-1a, then mulberry32: the same sequence on every device and on the server. */
function seeded(key: string): () => number {
  let h = 0x81_1c_9d_c5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01_00_01_93)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Who the Daily Outlaw can be (gauntlet slots): never the tutorial pair, never Two-Gun Delmer (his
 * always-missing first shot is his own rule), never the two special fights.
 */
export const DAILY_POOL: readonly number[] = [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14]

/** Fake-outs every street has; no twitch (on a no-bell day the call *is* his hand). */
const CUES = ['crow', 'creak', 'dog', 'tumbleweed'] as const

const COPY: Readonly<Record<DailyModifier, { title: string; blurb: string }>> = {
  fog: {
    title: 'Fog on Main Street',
    blurb: 'Thick fog. Listen for the bell.',
  },
  'double-fakes': {
    title: 'Double Trouble',
    blurb: 'Two fake sounds before the bell. Don’t draw early.',
  },
  'no-bell': { title: 'Watch His Hand', blurb: 'No bell. Draw when his hand moves.' },
}

/** What a modifier changes, in one plain line (the Daily sheet shows one per modifier). */
export const modifierRule = (m: DailyModifier): string => COPY[m].blurb

/** Today's duel. Deterministic in `day`. */
export function dailySpec(day: string): DailySpec {
  const rng = seeded(`out-west/daily/${DAILY_VERSION}/${day}`)
  const epochDay = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
  const first = DAILY_MODIFIERS[((epochDay % 3) + 3) % 3] as DailyModifier
  const modifiers: DailyModifier[] = [first]
  if (rng() < 1 / 3) {
    const rest = DAILY_MODIFIERS.filter((m) => m !== first)
    modifiers.push(rest[Math.floor(rng() * rest.length)] as DailyModifier)
  }
  modifiers.sort((a, b) => DAILY_MODIFIERS.indexOf(a) - DAILY_MODIFIERS.indexOf(b))
  const outlaw = DAILY_POOL[Math.floor(rng() * DAILY_POOL.length)] ?? 2
  const noBell = modifiers.includes('no-bell')
  // a hand is slower to read than a bell: the no-bell draw gives you 70 ms more
  const drawMs = Math.round(300 + rng() * 60 + (noBell ? 70 : 0))
  const lead = COPY[first]
  const extra = modifiers.length > 1 ? modifiers.find((m) => m !== first) : undefined
  return {
    day,
    outlaw,
    drawMs,
    jitterMs: 20,
    accuracy: 0.9,
    waitMs: [2000, 5000],
    fakes: modifiers.includes('double-fakes') ? 2 : Number(rng() < 0.6),
    cues: CUES,
    modifiers,
    title: lead.title,
    blurb: extra ? `${lead.blurb} ${COPY[extra].blurb}` : lead.blurb,
  }
}
