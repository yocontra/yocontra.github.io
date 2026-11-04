/**
 * The hub's mode tiles: Quick Draw (the single-player gauntlet), Bounty Hunt (PvP), Frontier
 * (free-for-all) and the Outfitter. Signed out, single player works fully and the online tiles
 * ask for a sign-in instead. A 2×2 grid in portrait, one row in landscape.
 */
import { type IconName, icon } from './icons.ts'
import { el } from './sheet.ts'

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
    mode: 'bounty',
    icon: 'bounty',
    title: 'Bounty Hunt',
    kicker: 'Live duels',
    sub: signInFirst,
    online: true,
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
  const back = el('div', 'ow-sheet on', root)
  back.setAttribute('role', 'dialog')
  back.setAttribute('aria-label', 'Quick Draw')
  const panel = el('div', 'ow-hub-panel ow-sheet-panel', back)
  el('h2', 'ow-hub-h', panel, 'Quick Draw')
  el(
    'p',
    'ow-hub-note',
    panel,
    s.signedIn
      ? 'Ranked runs pay XP and money. Beat 3 outlaws to earn your licence.'
      : 'Ranked runs go on the leaderboard. Sign in to earn XP and money.',
  )
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation()
      close(null)
    }
  }
  globalThis.addEventListener('keydown', onKey, true)
  const close = (c: GauntletChoice | null): void => {
    globalThis.removeEventListener('keydown', onKey, true)
    back.remove()
    done(c)
  }
  const list = el('div', 'ow-hub-choices', panel)
  const offered: QuickDrawPick[] = [
    ...(rankedOk ? (['ranked'] as const) : []),
    ...(s.continueAt > 0 ? (['continue'] as const) : []),
    'practice',
  ]
  const last = lastPick()
  const lead: QuickDrawPick = last && offered.includes(last) ? last : (offered[0] ?? 'practice')
  let focus = null as HTMLButtonElement | null
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
    if (pick === lead) {
      focus = b
    }
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
  requestAnimationFrame(() => focus?.focus())
  const row = el('div', 'ow-hub-row', panel)
  const cancel = el('button', 'ow-btn', row, 'Back')
  cancel.type = 'button'
  cancel.addEventListener('click', (e) => {
    e.stopPropagation()
    close(null)
  })
  const { map } = o
  if (map) {
    const m = el('button', 'ow-btn', row, 'Gauntlet map')
    m.type = 'button'
    m.addEventListener('click', (e) => {
      e.stopPropagation()
      close(null)
      map()
    })
  }
  back.addEventListener('click', (e) => {
    if (e.target === back) {
      close(null)
    }
  })
}
