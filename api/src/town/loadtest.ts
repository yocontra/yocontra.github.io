/**
 * End-to-end Frontier load test against a running API (e.g. `wrangler dev` on :8794).
 * Opens N real WebSocket clients that join through `POST /town/join`, play with human-like
 * send-on-change input (fights with a moving mouse, straight runs, idling), and asks the lobby
 * to add server bots. Reports bytes/s and messages/s per client and the DO's tick timing.
 *
 *   bun api/src/town/loadtest.ts [api=http://localhost:8794] [clients=3] [bots=29] [seconds=60]
 *
 * Dev auth only (`Bearer dev:<id>:<name>`, localhost). Seed accounts lt-1..lt-N for ledger writes.
 */
import { argv, stdout } from 'node:process'
import {
  BTN_FIRE,
  BTN_INTERACT,
  MSG_SNAPSHOT,
  type TownJoinResponse,
} from '../../../src/experiments/out-west/contract/town.ts'
import { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import {
  decodeSnapshot,
  type EntityView,
  encodeInput,
  type WireFrame,
} from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import { TICK_MS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { InputBatcher } from '../../../src/experiments/out-west/ffa/sim/input.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'
import type { LobbyStats } from './lobby.ts'

const ORIGIN = 'http://localhost:4344'

type Phase = 'fight' | 'walk' | 'idle'
/** Share of play time per phase, and how long each lasts (ticks). */
const PHASES: readonly [Phase, number, number, number][] = [
  ['fight', 0.45, 20, 80],
  ['walk', 0.25, 30, 100],
  ['idle', 0.3, 10, 60],
]

interface ClientStats {
  bytesIn: number
  msgsIn: number
  msgsOut: number
  bytesOut: number
  snapshots: number
  deposits: number
}

class FakeHuman {
  readonly stats: ClientStats = {
    bytesIn: 0,
    msgsIn: 0,
    msgsOut: 0,
    bytesOut: 0,
    snapshots: 0,
    deposits: 0,
  }
  private readonly batcher = new InputBatcher()
  private readonly writer = new Writer(64)
  private readonly baseline = new Map<number, EntityView>()
  private readonly rng: Rng
  private phase: Phase = 'idle'
  private phaseLeft = 0
  private move = { x: 0, z: 0 }
  private aim = 0
  private aimVel = 0
  private lastTick = 0
  private lastSnapAt = 0
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private n = 0

  constructor(seed: number) {
    this.rng = new Rng(seed)
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Bun's WebSocket accepts headers, so the origin check passes like a browser.
      const ws = new WebSocket(url, { headers: { Origin: ORIGIN } } as unknown as string[])
      ws.binaryType = 'arraybuffer'
      ws.onopen = (): void => {
        this.timer = setInterval(() => this.frame(), TICK_MS)
        resolve()
      }
      ws.onerror = (): void => reject(new Error('socket error'))
      ws.onmessage = (ev: MessageEvent): void => this.onMessage(ev.data as ArrayBuffer | string)
      this.ws = ws
    })
  }

  private onMessage(data: ArrayBuffer | string): void {
    this.stats.msgsIn++
    if (typeof data === 'string') {
      this.stats.bytesIn += data.length
      if (data.includes('"deposit"')) {
        this.stats.deposits++
      }
      return
    }
    this.stats.bytesIn += data.byteLength
    const bytes = new Uint8Array(data)
    if (bytes[0] === MSG_SNAPSHOT) {
      const snap = decodeSnapshot(bytes, this.baseline)
      if (snap) {
        this.stats.snapshots++
        this.lastTick = snap.tick
        this.lastSnapAt = performance.now()
      }
    }
  }

  private nextPhase(): void {
    let r = this.rng.next()
    for (const [phase, share, min, max] of PHASES) {
      r -= share
      if (r <= 0) {
        this.phase = phase
        this.phaseLeft = this.rng.int(min, max)
        break
      }
    }
    const a = this.rng.range(0, Math.PI * 2)
    this.move = this.phase === 'idle' ? { x: 0, z: 0 } : { x: Math.cos(a), z: Math.sin(a) }
    this.aimVel = this.phase === 'fight' ? this.rng.range(-900, 900) : 0
    if (this.phase === 'walk') {
      this.aim = Math.round((a / (Math.PI * 2)) * 65_536) & 0xff_ff
    }
  }

  private frame(): void {
    if (--this.phaseLeft <= 0) {
      this.nextPhase()
    }
    this.n++
    // A moving mouse in fights: aim drifts and jitters every frame.
    this.aim =
      (this.aim +
        Math.round(this.aimVel + this.rng.range(-200, 200) * (this.phase === 'fight' ? 1 : 0))) &
      0xff_ff
    let buttons = 0
    if (this.phase === 'fight' && this.n % 9 === 0) {
      buttons |= BTN_FIRE
    }
    if (this.phase === 'idle' && this.n % 40 === 0) {
      buttons |= BTN_INTERACT
    }
    const f: WireFrame = {
      moveX: Math.round(this.move.x * 127),
      moveZ: Math.round(this.move.z * 127),
      aim: this.aim,
      buttons,
      viewTick: (this.lastTick - 2) & 0xff_ff,
      viewFrac: 0,
    }
    const msg = this.batcher.push(f)
    if (msg && this.ws?.readyState === WebSocket.OPEN) {
      const age = Math.min(255, Math.round(performance.now() - this.lastSnapAt))
      const bytes = encodeInput(this.writer, {
        ...msg,
        ackTick: this.lastTick & 0xff_ff,
        ackAgeMs: age,
      })
      this.ws.send(bytes)
      this.stats.msgsOut++
      this.stats.bytesOut += bytes.length
    }
  }

  close(): void {
    clearInterval(this.timer)
    this.ws?.close(1000, 'done')
  }
}

async function joinTown(api: string, i: number, bots: number): Promise<TownJoinResponse> {
  const res = await fetch(`${api}/town/join`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer dev:lt-${i}:Loadtest ${i}`,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(i === 1 ? { bots } : {}),
  })
  if (!res.ok) {
    throw new Error(`join ${i}: ${res.status} ${await res.text()}`)
  }
  return res.json() as Promise<TownJoinResponse>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const api = argv[2] ?? 'http://localhost:8794'
  const clients = Number(argv[3] ?? 3)
  const bots = Number(argv[4] ?? 29)
  const seconds = Number(argv[5] ?? 60)
  const humans: FakeHuman[] = []
  let lobbyId = ''
  for (let i = 1; i <= clients; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: joins are sequential like real arrivals
    const joined = await joinTown(api, i, bots)
    lobbyId = joined.lobbyId
    const h = new FakeHuman(i * 7919)
    await h.connect(joined.wsUrl)
    humans.push(h)
  }
  // Let bots fill in, then measure.
  await sleep(3000)
  const start = humans.map((h) => ({ ...h.stats }))
  const t0 = performance.now()
  await sleep(seconds * 1000)
  const elapsed = (performance.now() - t0) / 1000
  const stats = (await (await fetch(`${api}/town/${lobbyId}/stats`)).json()) as LobbyStats
  const per = humans.map((h, i) => {
    const s0 = start[i] ?? h.stats
    return {
      bytesInPerSec: (h.stats.bytesIn - s0.bytesIn) / elapsed,
      msgsInPerSec: (h.stats.msgsIn - s0.msgsIn) / elapsed,
      msgsOutPerSec: (h.stats.msgsOut - s0.msgsOut) / elapsed,
      bytesOutPerSec: (h.stats.bytesOut - s0.bytesOut) / elapsed,
      snapshotsPerSec: (h.stats.snapshots - s0.snapshots) / elapsed,
    }
  })
  for (const h of humans) {
    h.close()
  }
  const msgsPerHumanHour = (per.reduce((a, p) => a + p.msgsOutPerSec, 0) / per.length) * 3600
  stdout.write(
    `${JSON.stringify(
      {
        lobbyId,
        clients,
        botsRequested: bots,
        seconds: elapsed,
        perClient: per,
        msgsPerHumanHour,
        humanHoursPer16M: 16_000_000 / msgsPerHumanHour,
        humanHoursPer1MBillable: 20_000_000 / msgsPerHumanHour,
        lobby: stats,
      },
      null,
      2,
    )}\n`,
  )
}

await main()
