/// <reference types="vite/client" />
/**
 * Screens `tools/ui-audit.ts` can't reach quickly by playing: the dev server serves this module to
 * the page (`/tools/ui-audit/fixtures.ts`) and it mounts the game's own UI classes with worst-case
 * data (16-character names, six-figure purses, every results outcome) in a fixture root over the
 * game. Nothing here re-implements a screen: it only calls the modules the game calls.
 */
import type {
  DuelResult,
  Poster,
  Settlement,
} from '../../src/experiments/out-west/contract/duel.ts'
import type { RosterEntry } from '../../src/experiments/out-west/contract/town.ts'
import { endView } from '../../src/experiments/out-west/duel/pvp-end.ts'
import { Hud as FrontierHud } from '../../src/experiments/out-west/ffa/client/hud.ts'
import { Riders } from '../../src/experiments/out-west/ffa/client/riders.ts'
import { load } from '../../src/experiments/out-west/save.ts'
import { Hud } from '../../src/experiments/out-west/ui/hud.ts'
import { MatchIntro } from '../../src/experiments/out-west/ui/match-intro.ts'
import { ResultsPanel } from '../../src/experiments/out-west/ui/results.ts'

/** The longest name the server allows (16), in wide capitals. */
export const LONG = 'WMWMWMWMWMWMWMWM'
const FX = 'ow-audit-fx'

const noop = (): void => undefined

/** A fresh fixture root over everything (the game's own root class, so its CSS applies). */
function root(cls: string): HTMLElement {
  for (const old of document.querySelectorAll(`.${FX}`)) {
    old.remove()
  }
  const r = document.createElement('div')
  r.className = `${cls} ${FX}`
  r.style.zIndex = '1000'
  r.style.position = 'fixed'
  r.style.inset = '0'
  document.body.append(r)
  return r
}

export function clear(): void {
  for (const old of document.querySelectorAll(`.${FX}`)) {
    old.remove()
  }
}

const poster = (kind: Poster['kind'], name = LONG): Poster => ({
  name,
  level: 50,
  prestige: 5,
  bounty: 99_999,
  streak: 12,
  cowardice: 3,
  loadout: {} as Poster['loadout'],
  kind,
})

const settlement = (delta: number, levelUp = false): Settlement =>
  ({
    delta,
    xp: 140,
    purse: 123_456,
    streak: delta > 0 ? 7 : 0,
    pairFactor: 0.5,
    lines: [
      { label: delta > 0 ? 'Bounty collected' : 'Bounty paid', amount: delta, xp: 100 },
      { label: 'Hot streak bonus', amount: delta > 0 ? 1250 : 0, xp: 40 },
      ...(levelUp ? [{ label: 'Level up · Lv 50', amount: 1250, xp: 0 }] : []),
    ],
    xpBefore: levelUp ? 99_000 : 120_000,
    xpAfter: levelUp ? 99_600 : 120_140,
    levelBefore: levelUp ? 49 : 50,
    levelAfter: 50,
    levelReward: levelUp ? 1250 : 0,
  }) as Settlement

const result = (o: Partial<DuelResult>): DuelResult => ({
  type: 'result',
  serverTime: Date.now(),
  matchId: 'room:0',
  draw: 2000,
  outcome: 'win',
  winner: 0,
  culprit: null,
  reactions: [187, 243],
  deadHeats: 0,
  you: settlement(4800),
  settled: true,
  ...o,
})

/** Every results state, by name. `closed` is what the room said after the verdict, if anything. */
const RESULTS: Record<
  string,
  { r: DuelResult; ghost?: boolean; lost?: string; closed?: string; votes?: [boolean, boolean] }
> = {
  win: { r: result({}) },
  'win-levelup': { r: result({ you: settlement(4800, true) }) },
  loss: { r: result({ winner: 1, you: settlement(-2400) }) },
  froze: { r: result({ outcome: 'froze', winner: null, reactions: [null, null] }) },
  draw: { r: result({ outcome: 'draw', winner: null, deadHeats: 2 }) },
  'coward-you': { r: result({ outcome: 'coward', winner: 1, culprit: 0, you: settlement(-2400) }) },
  'coward-him': { r: result({ outcome: 'coward', winner: 0, culprit: 1 }) },
  'forfeit-you': {
    r: result({ outcome: 'forfeit', winner: 1, culprit: 0, you: settlement(-2400) }),
    closed: 'The room closed.',
  },
  'forfeit-him': {
    r: result({ outcome: 'forfeit', winner: 0, culprit: 1 }),
    closed: 'He lit out of town.',
  },
  'dodge-you': {
    r: result({ outcome: 'dodge', winner: null, culprit: 0, you: settlement(-1200) }),
    closed: 'He lit out of town.',
  },
  'dodge-him': {
    r: result({ outcome: 'dodge', winner: null, culprit: 1, you: null }),
    closed: 'He lit out of town.',
  },
  'ghost-win': { r: result({}), ghost: true },
  'ghost-loss': { r: result({ winner: 1, you: settlement(-2400) }), ghost: true },
  'ghost-loss-closed': {
    r: result({ winner: 1, you: settlement(-2400) }),
    ghost: true,
    closed: 'The room closed.',
  },
  'room-closed': { r: result({}), closed: 'The room closed.' },
  'opponent-left': { r: result({}), closed: 'He lit out of town.' },
  'rematch-he-wants': { r: result({}), votes: [false, true] },
  'line-dead': {
    r: result({ outcome: 'forfeit', winner: null, you: null }),
    lost: 'The room hit a snag.',
  },
  pending: { r: result({ you: null, settled: false }) },
}

export const RESULT_STATES = Object.keys(RESULTS)

/** A results receipt in state `name`; returns the scope selector. */
export function results(name: string): string {
  const s = RESULTS[name]
  if (!s) {
    throw new Error(`no results state ${name}`)
  }
  const r = root('ow')
  const view = endView(s.r, 0, {
    name: LONG,
    xp: { before: 120_000, after: 120_140 },
    lost: s.lost ?? null,
    synced: false,
  })
  const panel = new ResultsPanel(
    r,
    view,
    { rematch: noop, next: noop, saloon: noop },
    { name: LONG, kind: s.ghost ? 'ghost' : 'human', context: 'room:0' },
  )
  panel.root.classList.add('on')
  panel.setRecord('Record 120–48 · best streak 14')
  if (s.votes) {
    panel.setVotes(s.votes, 0, 3)
  }
  if (s.closed) {
    // what pvp-duel does when the room closes after its verdict
    panel.disableRematch()
    panel.say(s.closed)
  }
  return '.ow-audit-fx .ow-results'
}

function duelHud(): Hud {
  const r = root('ow ow-playing ow-pvp')
  const hud = new Hud(r)
  hud.show(true)
  return hud
}

/** The duel HUD (counter, purse, pips, mode, a heckle). */
export function duelHudIdle(): string {
  const hud = duelHud()
  hud.root.classList.remove('ow-pvp')
  hud.setCounter(16, 17, true)
  hud.setPurse(1_234_567, false)
  hud.setPips(6, true)
  hud.setMode('Bounty Hunt · ghost')
  hud.line(LONG, 'You’ll be pushing up daisies before sundown, stranger.', 1e9)
  return '.ow-audit-fx'
}

/** The call: DRAW! and a fake-out caption together. */
export function duelHudCall(): string {
  const hud = duelHud()
  hud.call('DRAW!', 1e9)
  hud.fake('[his line dropped · 5 s grace]', 1e9)
  return '.ow-audit-fx'
}

/** The between-outlaws card. */
export function duelCard(): string {
  const hud = duelHud()
  hud.showCard({
    kind: 'win',
    title: `${LONG} is dead`,
    big: '187 ms',
    sub: 'Quicker than a rattlesnake with somewhere to be.',
    hint: 'Tap to face the next outlaw',
  })
  hud.cardPayout('+$12,500 bounty · +$2,500 clean kill')
  return '.ow-audit-fx .ow-card'
}

/** The pause menu. */
export function pause(): string {
  const hud = duelHud()
  hud.openMenu(load().settings, {
    resume: noop,
    change: noop,
    restart: noop,
    leaderboard: noop,
    saloon: noop,
    remap: noop,
  })
  return '.ow-audit-fx .ow-menu'
}

/** The gauntlet's end ledger, all seventeen outlaws. */
export function endLedger(): string {
  const hud = duelHud()
  const rows = Array.from({ length: 17 }, (_, i) => ({
    name: i % 3 === 0 ? 'Bartholomew “Two-Gun” Grady' : `Outlaw ${i + 1}`,
    ms: 150 + i * 13,
    grade: 'A+',
    attempts: 12,
    paid: 125_000,
  }))
  hud.showEnd(rows, {
    stats: {
      cowardice: 12,
      avg: 211,
      assist: true,
      legend: true,
      legendUnlocked: true,
      total: 1_234_567,
      best: 2_345_678,
      ranked: true,
    },
    onAgain: noop,
    onLegend: noop,
    onBoard: noop,
  })
  return '.ow-audit-fx .ow-end'
}

/** Both posters, before READY. */
export function matchIntro(ghost: boolean): string {
  const r = root('ow')
  const intro = new MatchIntro(r, poster('human'), poster(ghost ? 'ghost' : 'human'), {
    ready: noop,
    flee: noop,
  })
  intro.root.classList.add('on')
  return '.ow-audit-fx .ow-match'
}

function frontierHud(): FrontierHud {
  const real = document.querySelector<HTMLElement>('.fr-hud:not(.ow-audit-fx .fr-hud)')
  if (real) {
    real.style.visibility = 'hidden'
  }
  const r = root('fr-root')
  const hud = new FrontierHud(r, {
    touch: matchMedia('(pointer: coarse)').matches,
    onLeave: noop,
    onExit: noop,
    onRiders: noop,
    onKiller: noop,
  })
  // a stand-in the size of the live minimap, so the head count sits where it really does
  const map = real?.querySelector('.fr-map')?.getBoundingClientRect()
  if (map) {
    const stand = document.createElement('div')
    stand.style.width = `${map.width}px`
    stand.style.height = `${map.height}px`
    hud.mapSlot.append(stand)
  }
  return hud
}

/** The Frontier HUD with everything on at once: channel, prompt, most wanted, banner. */
export function frontierBusy(): string {
  const hud = frontierHud()
  hud.update({
    weapon: { label: 'Schofield .45', max: 6 },
    dynamite: true,
    hp: 37,
    ammo: 2,
    reload: 0.4,
    carried: 123_456,
    banked: 1_234_567,
    players: 32,
    mostWanted: true,
    channel: { label: 'Banking $123,456', t: 0.6 },
    prompt: 'E · Bank your carry',
    protectedFor: 3,
    lowPower: true,
  })
  hud.banner('Sundown in 60 seconds: the strongbox opens')
  hud.toast('The bank won’t take a dead man’s money', '', 1e9)
  return '.ow-audit-fx .fr-hud'
}

/** The death card, shot down by a player (with the poster link). */
export function frontierDeath(): string {
  const hud = frontierHud()
  hud.death(LONG, 'Dead-Eye from 31 m. You dropped $123,456.', 4, true)
  return '.ow-audit-fx .fr-death'
}

/** The riders sheet with sixteen people at the longest names. */
export function frontierRiders(): string {
  const r = root('fr-root ow')
  const roster = new Map<number, RosterEntry>()
  for (let i = 0; i < 18; i++) {
    roster.set(i, {
      id: i,
      name: i % 2 ? LONG : `Rider ${i}`,
      level: 50 - i,
      prestige: i % 6,
      bot: i > 15,
      loadout: [],
    })
  }
  new Riders({ root: r, roster: () => roster, you: () => 0, lobbyId: () => 'lobby-1' }).open()
  return '.ow-audit-fx .ow-sheet'
}
