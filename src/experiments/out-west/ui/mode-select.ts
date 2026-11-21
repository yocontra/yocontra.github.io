/**
 * The hub's mode tiles: Quick Draw (the single-player gauntlet), Bounty Hunt (PvP), Frontier
 * (free-for-all) and the Outfitter. Signed out, single player works fully and the online tiles
 * ask for a sign-in instead. Quick Draw and Frontier lead the grid.
 */
import { type IconName, icon } from './icons.ts'
import { el, panelSheet } from './sheet.ts'

export type Mode = 'gauntlet' | 'bounty' | 'frontier' | 'store'

export interface TileState {
  signedIn: boolean
  /** The game behind the hub has finished loading (single player can start). */
  ready: boolean
  /** Outlaw index a saved practice run would continue from (0 = fresh). */
  continueAt: number
}

interface TileDef {
  mode: Mode
  title: string
  kicker: string
  sub: (s: TileState) => string
  online: boolean
  icon: IconName
}

/**
 * A tile's line under its title is only for what the kicker and title can't say: still loading,
 * a run to continue, or a sign-in standing in the way. Otherwise it is empty and hidden.
 */
const signInFirst = (s: TileState): string => (s.signedIn ? '' : 'Sign in to play')

const TILES: readonly TileDef[] = [
  {
    mode: 'gauntlet',
    icon: 'revolver',
    title: 'Quick Draw',
    kicker: 'Single player',
    sub: (s) => {
      if (!s.ready) {
        return 'Loading…'
      }
      return s.continueAt > 0 ? `Outlaw ${s.continueAt + 1} of 17` : ''
    },
    online: false,
  },
  {
    mode: 'frontier',
    icon: 'dynamite',
    title: 'Frontier',
    kicker: 'Free-for-all',
    // the practice town is open to everyone; the live town asks for a sign-in on the sheet
    sub: (s) => (s.signedIn ? '' : 'Practice town open'),
    online: false,
  },
  {
    mode: 'bounty',
    icon: 'bounty',
    title: 'Bounty Hunt',
    kicker: 'Live duels',
    sub: signInFirst,
    online: true,
  },
  {
    mode: 'store',
    icon: 'hat',
    title: 'Outfitter',
    kicker: 'Cosmetics',
    sub: () => '',
    online: false,
  },
]

export class ModeTiles {
  readonly root: HTMLElement
  private readonly subs = new Map<Mode, HTMLElement>()
  private readonly btns = new Map<Mode, HTMLButtonElement>()

  constructor(parent: HTMLElement, pick: (m: Mode) => void) {
    this.root = el('nav', 'ow-tiles', parent)
    this.root.setAttribute('aria-label', 'Choose a game')
    for (const t of TILES) {
      const b = el('button', `ow-tile ow-tile-${t.mode}`, this.root)
      b.type = 'button'
      b.append(icon(t.icon))
      el('span', 'ow-tile-kicker', b, t.kicker)
      el('span', 'ow-tile-title', b, t.title)
      this.subs.set(t.mode, el('span', 'ow-tile-sub', b))
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        pick(t.mode)
      })
      this.btns.set(t.mode, b)
    }
  }

  update(s: TileState): void {
    for (const t of TILES) {
      const sub = this.subs.get(t.mode)
      if (sub) {
        sub.textContent = t.sub(s)
      }
      const b = this.btns.get(t.mode)
      b?.classList.toggle('locked', t.online && !s.signedIn)
      b?.classList.toggle('waiting', t.mode === 'gauntlet' && !s.ready)
    }
  }
}

export interface GauntletChoice {
  ranked: boolean
  /** Continue a practice run from its saved outlaw instead of starting over. */
  resume: boolean
}

type QuickDrawPick = 'ranked' | 'continue' | 'practice'
const LAST_KEY = 'out-west-last-quickdraw'

/** The Quick Draw choice made last time on this device (it leads the sheet next time). */
function lastPick(): QuickDrawPick | null {
  try {
    const v = localStorage.getItem(LAST_KEY)
    return v === 'ranked' || v === 'continue' || v === 'practice' ? v : null
  } catch {
    return null
  }
}

function rememberPick(p: QuickDrawPick): void {
  try {
    localStorage.setItem(LAST_KEY, p)
  } catch {
    // private mode: the sheet just leads with the default
  }
}

/**
 * Ranked from outlaw 1, or practice (continuing a saved run when there is one), and the way to
 * the Gauntlet map when the meta-game is there. The choice you made last time leads (and has the
 * focus), so Enter or one tap repeats it.
 */
export function gauntletSheet(
  root: HTMLElement,
  s: TileState,
  o: { rankedOk: boolean; map?: () => void },
  done: (c: GauntletChoice | null) => void,
): void {
  const { rankedOk } = o
  let picked: GauntletChoice | null = null
  const sheet = panelSheet(root, { title: 'Quick Draw', onClose: () => done(picked) })
  const panel = sheet.body
  const close = (selection: GauntletChoice | null): void => {
    picked = selection
    sheet.close()
  }
  el(
    'p',
    'ow-hub-note',
    panel,
    s.signedIn
      ? 'Ranked runs pay XP and money. Beat 3 outlaws to earn your licence.'
      : 'Ranked runs go on the leaderboard. Sign in to earn XP and money.',
  )
  const list = el('div', 'ow-hub-choices', panel)
  const offered: QuickDrawPick[] = [
    ...(rankedOk ? (['ranked'] as const) : []),
    ...(s.continueAt > 0 ? (['continue'] as const) : []),
    'practice',
  ]
  const last = lastPick()
  const lead: QuickDrawPick = last && offered.includes(last) ? last : (offered[0] ?? 'practice')
  const choice = (title: string, sub: string, c: GauntletChoice, pick: QuickDrawPick): void => {
    const b = el('button', `ow-choice${pick === lead ? ' primary' : ''}`, list)
    b.type = 'button'
    el('b', '', b, title)
    el('span', '', b, sub)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      rememberPick(pick)
      close(c)
    })
  }
  if (rankedOk) {
    choice(
      'Ranked gauntlet',
      'From outlaw 1 · pays XP and money',
      { ranked: true, resume: false },
      'ranked',
    )
  }
  if (s.continueAt > 0) {
    choice(
      `Continue · outlaw ${s.continueAt + 1}`,
      'Practice · not ranked',
      { ranked: false, resume: true },
      'continue',
    )
  }
  choice('Practice', 'From outlaw 1 · not ranked', { ranked: false, resume: false }, 'practice')
  list.querySelector<HTMLButtonElement>('.primary')?.focus()
  const { map } = o
  if (map) {
    const row = el('div', 'ow-hub-row', panel)
    const m = el('button', 'ow-btn', row, 'Gauntlet map')
    m.type = 'button'
    m.addEventListener('click', (e) => {
      e.stopPropagation()
      close(null)
      map()
    })
  }
}
