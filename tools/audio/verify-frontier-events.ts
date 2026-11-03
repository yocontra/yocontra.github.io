// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * Frontier's event → sound wiring, without a browser: feeds `handleEvent` / `handleControl` the
 * server events a session produces (shots of each weapon, hits, dynamite, a bag, the strongbox, a
 * deposit, a respawn, showdowns) through a recording stand-in for the audio engine, and checks each
 * cue fires once, with the right name, and that no call is ever a positional bell.
 *
 *   bun tools/audio/verify-frontier-events.ts
 *
 * The live soundscape (footsteps, beds, voices, meters) is `verify-frontier.ts`; this covers the
 * money and showdown beats a scripted session can't reliably reach in loopback (bots never mint).
 */
import type { AudioEngine } from '../../src/experiments/out-west/audio/audio.ts'
import {
  EV_BAG_DROP,
  EV_BAG_GONE,
  EV_DEPOSIT,
  EV_DYNAMITE_THROWN,
  EV_EXPLOSION,
  EV_PICKUP_TAKEN,
  EV_RESPAWN,
  EV_SHOT,
  EV_SHOWDOWN_CALL,
  EV_SHOWDOWN_START,
  EV_STRONGBOX_OPEN,
  POS_SCALE,
  SHOT_HIT,
  SHOT_RANGE_UNIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  SHOT_WALL,
} from '../../src/experiments/out-west/contract/town.ts'
import type { Fuse } from '../../src/experiments/out-west/ffa/client/event-sounds.ts'
import {
  handleControl,
  handleEvent,
  type Showdown,
  type Sink,
} from '../../src/experiments/out-west/ffa/client/events.ts'
import type { WireEvent } from '../../src/experiments/out-west/ffa/sim/codec-events.ts'

const calls: string[] = []
const record =
  (kind: string) =>
  (name?: unknown, o?: unknown): { stop: () => void; set: () => void } => {
    const pos = typeof o === 'object' && o !== null && 'pos' in o ? ' @pos' : ''
    calls.push(`${kind} ${String(name ?? '')}${pos}`.trim())
    return { stop: () => calls.push(`loopStop ${String(name)}`), set: () => undefined }
  }
const audio = {
  play: record('play'),
  impact: record('impact'),
  footstep: record('footstep'),
  whizz: record('whizz'),
  musicLevel: record('musicLevel'),
  call: () => {
    calls.push('call')
    return null
  },
  loop: (name: string, _g: number, _b: string, pos?: unknown) => {
    calls.push(`loop ${name}${pos ? ' @pos' : ''}`)
    return { stop: () => calls.push(`loopStop ${name}`), set: () => undefined }
  },
} as unknown as AudioEngine

/** Anything not under test: every property is a no-op function that returns itself. */
const inert: unknown = new Proxy(() => inert, { get: () => inert })
const you = 1
const SPOTS: Record<number, { x: number; z: number }> = {
  1: { x: 70, z: 50 },
  2: { x: 66, z: 50 },
  3: { x: 200, z: 60 },
  4: { x: 68, z: 45 },
  5: { x: 52, z: 80 },
}
const bags = new Map<number, { id: number; x: number; z: number; amount: number }>()
const showdowns = new Map<number, Showdown>()
const fuses = new Map<number, Fuse>()
const sink = {
  net: new Proxy({ you, name: () => 'Someone' }, { get: (t, k) => Reflect.get(t, k) ?? inert }),
  fx: new Proxy({ bags }, { get: (t, k) => Reflect.get(t, k) ?? inert }),
  crowd: inert,
  hud: inert,
  audio,
  kick: () => undefined,
  // 2: beside you; 3: far away; 4: 10 m short of the hotel's wood wall; 5: of the bank's stone
  posOf: (id: number) => SPOTS[id] ?? null,
  muzzleOf: () => inert,
  showdowns,
  callouts: [],
  killer: null,
  onLeft: () => undefined,
  pickups: inert,
  fuses,
} as unknown as Sink

const failures: string[] = []
function expect(label: string, ev: WireEvent | (() => void), want: string[]): void {
  calls.length = 0
  if (typeof ev === 'function') {
    ev()
  } else {
    handleEvent(sink, ev)
  }
  const ok = want.every((w) => calls.filter((c) => c === w).length === 1)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${calls.join(', ')}`)
  if (!ok) {
    failures.push(label)
  }
}

const shot = (flags: number, shooter = 2): WireEvent =>
  ({
    type: EV_SHOT,
    shooter,
    aim: 0,
    range: 10 / SHOT_RANGE_UNIT,
    target: 255,
    flags,
  }) as unknown as WireEvent
expect("someone's revolver hits you", shot(SHOT_HIT), ['play fire @pos', 'impact body @pos'])
expect("someone's rifle hits a wood wall", shot(SHOT_RIFLE | SHOT_WALL, 4), [
  'play rifleFire @pos',
  'impact wood @pos',
])
expect("someone's revolver hits the bank", shot(SHOT_WALL, 5), [
  'play fire @pos',
  'impact metal @pos',
])
expect('a shot into the open street', shot(SHOT_WALL), ['play fire @pos', 'impact dirt @pos'])
expect("someone's shotgun misses", shot(SHOT_SHOTGUN), ['play shotgunFire @pos'])
expect('a far shot spends no impact', shot(SHOT_HIT, 3), ['play fire @pos'])
expect('you take the rifle', { type: EV_PICKUP_TAKEN, spot: 1, player: you } as WireEvent, [
  'play rifleLever',
])
expect('you take the shotgun', { type: EV_PICKUP_TAKEN, spot: 2, player: you } as WireEvent, [
  'play shotgunLoad',
])
const at = { x: 66 * POS_SCALE, z: 60 * POS_SCALE }
expect(
  'dynamite thrown',
  { type: EV_DYNAMITE_THROWN, player: 2, ...at, fuseTicks: 40 } as WireEvent,
  ['play whip @pos', 'loop fuse @pos'],
)
expect('the blast', { type: EV_EXPLOSION, by: 2, ...at } as WireEvent, [
  'loopStop fuse',
  'play explosion @pos',
])
handleEvent(sink, {
  type: EV_BAG_DROP,
  bagId: 7,
  ...at,
  amount: 120,
  exclusiveFor: 255,
} as WireEvent)
expect('you pick up a fat bag', { type: EV_BAG_GONE, bagId: 7, by: you } as WireEvent, [
  'play coins',
])
handleEvent(sink, {
  type: EV_BAG_DROP,
  bagId: 8,
  ...at,
  amount: 15,
  exclusiveFor: 255,
} as WireEvent)
expect('you pick up a thin bag', { type: EV_BAG_GONE, bagId: 8, by: you } as WireEvent, [
  'play coin',
])
expect(
  'you crack the strongbox',
  { type: EV_STRONGBOX_OPEN, spot: 0, by: you, value: 420 } as WireEvent,
  ['play register'],
)
expect('you bank', { type: EV_DEPOSIT, player: you, amount: 420, commission: 0 } as WireEvent, [
  'play deposit',
])
expect('you respawn', { type: EV_RESPAWN, player: you } as WireEvent, ['play respawn'])
// showdowns: a bystander call is the call (never a positional bell), and silent while yours waits
const sd = (id: number, a: number, b: number): WireEvent =>
  ({ type: EV_SHOWDOWN_START, id, a, b, cx: at.x, cz: at.z }) as unknown as WireEvent
handleEvent(sink, sd(1, 4, 5))
expect('a bystander showdown is called', { type: EV_SHOWDOWN_CALL, id: 1 } as WireEvent, ['call'])
handleEvent(sink, sd(2, you, 6))
handleEvent(sink, sd(3, 7, 8))
calls.length = 0
handleEvent(sink, { type: EV_SHOWDOWN_CALL, id: 3 } as WireEvent)
const leaked = calls.length
console.log(
  `${leaked === 0 ? 'ok  ' : 'FAIL'} ${"another's call while yours waits".padEnd(34)} ${calls.join(', ') || '(silent)'}`,
)
if (leaked > 0) {
  failures.push('bystander bell during your showdown')
}
expect(
  'your own call',
  () =>
    handleControl(sink, {
      type: 'showdown_call',
      showdownId: 2,
    } as unknown as Parameters<typeof handleControl>[1]),
  ['call'],
)
for (const f of fuses.values()) {
  clearTimeout(f.timer)
}
console.log(failures.length === 0 ? '\nall cues wired' : `\nFAILED: ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
