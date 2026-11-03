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

const TILES: readonly TileDef[] = [
  {
    mode: 'gauntlet',
    icon: 'revolver',
    title: 'Quick Draw',
    kicker: 'Single player',
    sub: (s) => (s.ready ? '17 outlaws · ranked board' : 'Saddling up…'),
    online: false,
  },
  {
    mode: 'bounty',
    icon: 'bounty',
    title: 'Bounty Hunt',
    kicker: 'Live duels',
    sub: (s) => (s.signedIn ? 'Live PvP · ghosts if the street’s empty' : 'Sign in with a passkey'),
    online: true,
  },
  {
    mode: 'frontier',
    icon: 'dynamite',
    title: 'Frontier',
    kicker: 'Free-for-all',
    sub: (s) => (s.signedIn ? '32 guns · bank what you take' : 'Sign in with a passkey'),
    online: true,
  },
  {
    mode: 'store',
    icon: 'hat',
    title: 'Outfitter',
    kicker: 'Cosmetics',
    sub: (s) => (s.signedIn ? 'Hats, irons, dusters' : 'Browse and try on'),
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

/** Ranked from outlaw 1, or practice (continuing a saved run when there is one). */
export function gauntletSheet(
  root: HTMLElement,
  s: TileState,
  rankedOk: boolean,
  done: (c: GauntletChoice | null) => void,
): void {
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
      ? 'Ranked runs pay XP and dollars. Beat the first 3 outlaws to earn your licence.'
      : 'Ranked runs go on the board under a name you type. Sign in to earn XP and dollars.',
  )
  const close = (c: GauntletChoice | null): void => {
    back.remove()
    done(c)
  }
  const list = el('div', 'ow-hub-choices', panel)
  const choice = (title: string, sub: string, c: GauntletChoice, primary: boolean): void => {
    const b = el('button', `ow-choice${primary ? ' primary' : ''}`, list)
    b.type = 'button'
    el('b', '', b, title)
    el('span', '', b, sub)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      close(c)
    })
  }
  if (rankedOk) {
    choice(
      'Ranked gauntlet',
      'From outlaw 1 · server-judged',
      { ranked: true, resume: false },
      true,
    )
  }
  if (s.continueAt > 0) {
    choice(
      `Continue · outlaw ${s.continueAt + 1}`,
      'Practice · not ranked',
      { ranked: false, resume: true },
      !rankedOk,
    )
  }
  choice('Practice', 'From outlaw 1 · not ranked', { ranked: false, resume: false }, false)
  const cancel = el('button', 'ow-btn', panel, 'Back')
  cancel.type = 'button'
  cancel.addEventListener('click', (e) => {
    e.stopPropagation()
    close(null)
  })
  back.addEventListener('click', (e) => {
    if (e.target === back) {
      close(null)
    }
  })
}
