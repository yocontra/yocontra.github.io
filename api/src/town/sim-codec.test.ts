import { describe, expect, test as it } from 'bun:test'
import {
  BTN_FIRE,
  EVENT_SIZES,
  INPUT_FRAME_BYTES,
  INPUT_HEADER_BYTES,
  INPUT_LEAD_NONE,
  POS_SCALE,
  SNAP_FULL,
} from '../../../src/experiments/out-west/contract/town.ts'
import { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import {
  decodeInput,
  decodeSnapshot,
  type EntityView,
  encodeInput,
  encodeSnapshot,
  type SelfView,
  unwrapTick16,
  type WireFrame,
} from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import {
  EVENT_LAYOUTS,
  type WireEvent,
} from '../../../src/experiments/out-west/ffa/sim/codec-events.ts'
import { InputBatcher, quantizeAim } from '../../../src/experiments/out-west/ffa/sim/input.ts'
import { InputQueue } from '../../../src/experiments/out-west/ffa/sim/input-queue.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'
import { ClientStream, snapshotFor } from '../../../src/experiments/out-west/ffa/sim/snapshot.ts'
import { place, run, testWorld } from './test-helpers.ts'

const rng = new Rng(99)
const u8 = () => rng.int(0, 255)
const u16 = () => rng.int(0, 65_535)

const randomFrame = (): WireFrame => ({
  moveX: rng.int(-127, 127),
  moveZ: rng.int(-127, 127),
  aim: u16(),
  buttons: u16(),
  viewTick: u16(),
  viewFrac: u8(),
  pitch: rng.int(-127, 127),
})

const randomSelf = (): SelfView => ({
  x: u16(),
  z: u16(),
  y: u16() / 100,
  roof: rng.int(0, 4),
  climbTicks: u8(),
  climbDeck: u8(),
  climbDir: rng.int(-1, 1),
  fallTicks: u8(),
  fallTotal: u8(),
  fallFromX: u16() / 100,
  fallFromZ: u16() / 100,
  fallFromY: u8() / 10,
  fallToX: u16() / 100,
  fallToZ: u16() / 100,
  hp: rng.int(0, 100),
  ammo: rng.int(0, 6),
  flags: u8(),
  rollTicks: u8(),
  rollCooldown: u8(),
  rollDir: u16(),
  reloadTicks: u8(),
  fireCooldown: u8(),
  protectTicks: u8(),
  deadEyeTicks: u8(),
  channelKind: rng.int(0, 4),
  channelTicks: u8(),
  carried: rng.int(0, 4_000_000),
  respawnTicks: u8(),
  holsterTicks: u8(),
  lastButtons: u16(),
  weapon: u8(),
  jumpTicks: u8(),
  jumpCooldown: u8(),
  vaultStep: u8(),
  vaultAim: u16(),
  moveFlags: u8(),
  sprintLock: u8(),
  sprintOut: u8(),
  slideTicks: u8(),
  slideCooldown: u8(),
  slideAim: u16(),
  airX: rng.int(-127, 127),
  airZ: rng.int(-127, 127),
  vy: rng.int(-127, 127) / 10,
  grounded: rng.int(0, 1),
  support: u16() / 100,
  airPeakY: u16() / 100,
  mantleTicks: u8(),
})

function randomEvent(): WireEvent {
  const types = Object.keys(EVENT_LAYOUTS).map(Number)
  const type = types[rng.int(0, types.length - 1)] ?? 1
  const ev: Record<string, number> = { type }
  for (const [name, width] of EVENT_LAYOUTS[type] ?? []) {
    ev[name] = width === 1 ? u8() : u16()
  }
  return ev as unknown as WireEvent
}

/** Move, add and remove entities at random. */
function mutate(truth: Map<number, EntityView>): void {
  for (let id = 0; id < 32; id++) {
    const e = truth.get(id)
    if (!e && rng.next() < 0.1) {
      truth.set(id, {
        id,
        x: u16(),
        z: u16(),
        y: rng.int(0, 40),
        aim: u8(),
        hp: rng.int(0, 100),
        flags: u8(),
        anim: rng.int(0, 7),
        carry: u8(),
        pitch: rng.int(-127, 127),
      })
    } else if (e && rng.next() < 0.02) {
      truth.delete(id)
    } else if (e) {
      const jump = rng.next() < 0.05 ? 500 : 120
      e.x = Math.max(0, Math.min(65_535, e.x + rng.int(-jump, jump)))
      e.z = Math.max(0, Math.min(65_535, e.z + rng.int(-jump, jump)))
      if (rng.next() < 0.1) {
        e.y = rng.int(0, 40)
      }
      if (rng.next() < 0.3) {
        e.aim = u8()
      }
      if (rng.next() < 0.1) {
        e.hp = rng.int(0, 100)
      }
    }
  }
}

describe('input codec', () => {
  it('round-trips random messages (fuzz)', () => {
    const w = new Writer()
    for (let i = 0; i < 2000; i++) {
      const msg = {
        seq: u16(),
        ackTick: u16(),
        ackAgeMs: u8(),
        frames: Array.from({ length: rng.int(1, 4) }, randomFrame),
      }
      const bytes = encodeInput(w, msg)
      expect(bytes.length).toBe(INPUT_HEADER_BYTES + msg.frames.length * INPUT_FRAME_BYTES)
      expect(decodeInput(bytes)).toEqual(msg)
    }
  })

  it('a normal two-frame message is 27 bytes', () => {
    const bytes = encodeInput(new Writer(), {
      seq: 1,
      ackTick: 0,
      ackAgeMs: 0,
      frames: [randomFrame(), randomFrame()],
    })
    expect(bytes.length).toBe(27)
  })

  it('rejects garbage, truncation, wrong types and too many frames', () => {
    const good = encodeInput(new Writer(), {
      seq: 1,
      ackTick: 2,
      ackAgeMs: 3,
      frames: [randomFrame()],
    })
    expect(decodeInput(good.slice(0, good.length - 1))).toBeNull()
    expect(decodeInput(new Uint8Array([9, 0, 0, 1, 0, 0, 0]))).toBeNull()
    const five = new Uint8Array(INPUT_HEADER_BYTES + 5 * INPUT_FRAME_BYTES)
    five[0] = 1
    five[3] = 5
    expect(decodeInput(five)).toBeNull()
    for (let i = 0; i < 2000; i++) {
      const junk = new Uint8Array(rng.int(0, 40)).map(() => u8())
      // Junk either fails to decode or decodes to at least one frame.
      expect(decodeInput(junk)?.frames.length ?? 1).toBeGreaterThan(0)
    }
  })

  it('unwraps 16-bit ticks near the reference', () => {
    expect(unwrapTick16(65_530, 65_540)).toBe(65_530)
    expect(unwrapTick16(4, 65_534)).toBe(65_540)
    expect(unwrapTick16(100, 200_000 + 98)).toBe(196_708)
  })
})

describe('snapshot codec', () => {
  it('round-trips random snapshot sequences with delta baselines (fuzz)', () => {
    const w = new Writer()
    const sendBase = new Map<number, EntityView>()
    const recvBase = new Map<number, EntityView>()
    const truth = new Map<number, EntityView>()
    for (let tick = 0; tick < 1500; tick++) {
      mutate(truth)
      const removed = [...sendBase.keys()].filter((id) => !truth.has(id))
      const self = randomSelf()
      const events = Array.from({ length: rng.int(0, 5) }, randomEvent)
      const town =
        rng.next() < 0.1
          ? {
              mostWanted: u8(),
              mwX: u8(),
              mwZ: u8(),
              strongboxSpot: u8(),
              strongboxValue: u16(),
              strongboxState: rng.int(0, 2),
              players: u8(),
              banked: rng.int(0, 1e9),
            }
          : null
      const lead = rng.next() < 0.1 ? INPUT_LEAD_NONE : rng.int(-127, 127)
      const bytes = encodeSnapshot(
        w,
        {
          tick,
          lastInputSeq: tick & 0xff_ff,
          inputLead: lead,
          flags: 0,
          self,
          entities: [...truth.values()],
          removed,
          town,
          events,
        },
        sendBase,
      )
      const snap = decodeSnapshot(bytes, recvBase)
      expect(snap?.tick).toBe(tick)
      expect(snap?.inputLead).toBe(lead)
      expect(snap?.self).toEqual(self)
      expect(snap?.events).toEqual(events)
      expect(snap?.town).toEqual(town)
      expect(snap?.removed).toEqual(removed)
      expect([...recvBase.entries()].toSorted((a, b) => a[0] - b[0])).toEqual(
        [...truth.entries()]
          .map(([id, e]) => [id, { ...e }] as [number, EntityView])
          .toSorted((a, b) => a[0] - b[0]),
      )
    }
  })

  it('event layouts match the contract sizes', () => {
    for (const [type, layout] of Object.entries(EVENT_LAYOUTS)) {
      const bytes: number = layout.reduce((n, [, width]) => n + width, 0)
      expect(`${type}:${bytes}`).toBe(`${type}:${EVENT_SIZES[Number(type)] ?? -1}`)
    }
  })

  it('world snapshots: full first, then small deltas, and the client baseline tracks the server', () => {
    const w = testWorld()
    const viewer = place(w, 30, 64)
    for (let i = 0; i < 10; i++) {
      place(w, 20 + i * 3, 66)
    }
    const far = place(w, 130, 130)
    run(w, 1)
    const stream = new ClientStream()
    const recv = new Map<number, EntityView>()
    const out = new Writer()
    const first = snapshotFor(w, { viewer, stream }, { banked: 500, events: w.events }, out)
    const snap = decodeSnapshot(first, recv)
    expect((snap?.flags ?? 0) & SNAP_FULL).toBeTruthy()
    expect(snap?.town?.banked).toBe(500)
    expect(recv.size).toBe(10)
    expect(recv.has(far.id)).toBe(false)
    const sizes: number[] = []
    for (let t = 0; t < 40; t++) {
      run(w, 1, Object.fromEntries([...recv.keys()].map((id) => [id, () => ({ moveX: 127 })])))
      const bytes = snapshotFor(w, { viewer, stream }, { banked: 500, events: w.events }, out)
      sizes.push(bytes.length)
      decodeSnapshot(bytes, recv)
    }
    for (const [id, e] of recv) {
      const p = w.players[id]
      expect(e.x).toBe(Math.round((p?.x ?? 0) * POS_SCALE))
    }
    expect(Math.max(...sizes.slice(5))).toBeLessThan(first.length + 40)
  })
})

describe('send-on-change input', () => {
  const still: WireFrame = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTick: 0, viewFrac: 0 }

  it('silence while unchanged, a keepalive every 500 ms, frames as soon as anything changes', () => {
    const b = new InputBatcher()
    const sent: number[] = []
    for (let t = 0; t < 40; t++) {
      const f = t === 25 ? { ...still, buttons: BTN_FIRE } : still
      if (b.push(f)) {
        sent.push(t)
      }
    }
    // First slot, keepalives every 10 ticks, the fire at 25 (sent at the slot end, 25), release at 27.
    expect(sent).toContain(1)
    expect(sent).toContain(25)
    expect(sent).toContain(27)
    expect(sent.length).toBeLessThanOrEqual(8)
  })

  it('aim jitter below 1/1024 turn is not a change', () => {
    expect(quantizeAim(1000)).toBe(quantizeAim(1010))
    const b = new InputBatcher()
    let sends = 0
    for (let t = 0; t < 40; t++) {
      if (b.push({ ...still, aim: 1000 + (t % 3) * 5 })) {
        sends++
      }
    }
    expect(sends).toBeLessThanOrEqual(5)
  })

  it('the server reconstructs every frame the client made (prediction stays exact)', () => {
    const b = new InputBatcher()
    const q = new InputQueue()
    const made: WireFrame[] = []
    const applied: { seq: number; frame: WireFrame }[] = []
    for (let t = 0; t < 400; t++) {
      const moving = Math.floor(t / 30) % 2 === 0
      const f = {
        ...still,
        moveX: moving ? 127 : 0,
        aim: quantizeAim(Math.floor(t / 7) * 300),
        buttons: t % 50 === 0 ? BTN_FIRE : 0,
      }
      made.push(f)
      const msg = b.push(f)
      if (msg) {
        q.push(msg.seq, msg.frames)
      }
      const next = q.next()
      if (next) {
        applied.push(next)
      }
    }
    expect(applied.length).toBeGreaterThan(380)
    for (const a of applied) {
      const f = made[a.seq]
      expect(a.frame.moveX).toBe(f?.moveX ?? -1)
      expect(a.frame.aim).toBe(f?.aim ?? -1)
    }
    expect(applied.filter((a) => a.frame.buttons & BTN_FIRE).length).toBe(8)
    expect(q.dropped).toBe(0)
  })

  it('a late frame is applied next tick and keeps its press; a client far ahead is fast-forwarded', () => {
    const q = new InputQueue()
    q.push(10, [still, still])
    expect(q.next()?.seq).toBe(10)
    expect(q.next()?.seq).toBe(11)
    expect(q.next()?.seq).toBe(12)
    q.push(12, [{ ...still, buttons: BTN_FIRE }])
    const n = q.next()
    expect(n?.seq).toBe(13)
    expect((n?.frame.buttons ?? 0) & BTN_FIRE).toBeTruthy()
    q.push(40, [still, still])
    expect(q.next()?.seq).toBe(40)
  })
})
