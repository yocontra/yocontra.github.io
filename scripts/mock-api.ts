// biome-ignore-all lint/style/noNestedTernary: a throwaway dev mock; terse tables over ceremony
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the mock settlement mirrors the spec table inline
// biome-ignore-all lint/complexity/useMaxParams: ledger rows are positional in this mock
// biome-ignore-all lint/performance/useTopLevelRegex: two one-off regexes in a dev server
// biome-ignore-all lint/suspicious/noShadow: short-lived locals in a dev server
// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * A local mock of the out west API for stream D's client work, until the real Worker pieces
 * (auth, economy, matchmaker, duel room) are merged: `bun scripts/mock-api.ts [port]`.
 *
 * - `POST /dev/sign-in {name}` stands in for passkeys: it sets a cookie that `POST /auth/refresh`
 *   turns into a session for stream A's client (set the `ow-auth-hint` localStorage key too).
 * - `/me`, `/me/ledger`, `/store`, `/store/buy` and `/me/loadout` follow `contract/economy.ts`.
 * - `POST /queue/ticket` and `/queue/ws` follow the queue half of `contract/duel.ts`: two humans
 *   in the queue are paired; alone, you get a labelled ghost at 18 s (or on "Duel a ghost now").
 * - `/duel/:id/ws` runs `MockRoom`.
 *
 * Everything lives in memory and resets on restart. Never deploy this.
 */
import type { ServerWebSocket } from 'bun'
import type {
  Poster,
  QueueServerMessage,
  Seat,
  Settlement,
} from '../src/experiments/out-west/contract/duel.ts'
import type { LedgerRow, MeResponse } from '../src/experiments/out-west/contract/economy.ts'
import {
  CATALOG,
  canBuy,
  DEFAULT_LOADOUT,
  type ItemId,
  itemById,
  type Loadout,
  loadoutError,
  STARTER_ITEMS,
} from '../src/experiments/out-west/data/catalog.ts'
import {
  bountyForLevel,
  duelPayout,
  duelPenalty,
  levelProgress,
  levelRewards,
  titleFor,
} from '../src/experiments/out-west/data/progression.ts'
import { MockRoom } from './mock-duel-room.ts'

const PORT = Number(process.argv[2] ?? 8796)
const ORIGIN = `localhost:${PORT}`

interface Account {
  id: string
  name: string
  purse: number
  xp: number
  streak: number
  owned: Set<string>
  loadout: Loadout
  ledger: LedgerRow[]
}

const accounts = new Map<string, Account>()
let ledgerId = 1

function account(token: string | null): Account | null {
  return token ? (accounts.get(token) ?? null) : null
}

function grant(
  a: Account,
  kind: LedgerRow['kind'],
  amount: number,
  xp: number,
  ref: string | null,
): void {
  const before = levelProgress(a.xp).level
  a.purse = Math.max(0, a.purse + amount)
  a.xp += xp
  a.ledger.unshift({
    id: ledgerId++,
    kind,
    amount,
    xp,
    balanceAfter: a.purse,
    ref,
    createdAt: Date.now(),
  })
  const after = levelProgress(a.xp).level
  if (after > before) {
    const r = levelRewards(before, after)
    a.purse += r
    a.ledger.unshift({
      id: ledgerId++,
      kind: 'level_reward',
      amount: r,
      xp: 0,
      balanceAfter: a.purse,
      ref: `L${after}`,
      createdAt: Date.now(),
    })
  }
}

function me(a: Account): MeResponse {
  const p = levelProgress(a.xp)
  return {
    accountId: a.id,
    name: a.name,
    purse: a.purse,
    xp: a.xp,
    level: p.level,
    prestige: 0,
    loadout: a.loadout,
    title: titleFor(p.level),
    bounty: bountyForLevel(p.level),
    xpInto: p.into,
    xpNext: p.next,
    owned: [...a.owned] as ItemId[],
    gauntletClears: 0,
  }
}

function poster(a: Account): Poster {
  const level = levelProgress(a.xp).level
  return {
    name: a.name,
    level,
    prestige: 0,
    bounty: bountyForLevel(level, a.streak),
    streak: a.streak,
    cowardice: 0,
    loadout: { ...a.loadout },
    kind: 'human',
  }
}

const GHOSTS = ['Hollis Crane', 'Ada Blackwood', 'Silas Mott', 'June Ketchum']
const GHOST_KIT: Loadout = {
  ...DEFAULT_LOADOUT,
  hat: 'hat.sombrero',
  outfit: 'outfit.striped-poncho',
  gun: 'gun.nickel-six',
  extra: 'extra.handlebar',
}

function ghostPoster(level: number): Poster {
  return {
    name: GHOSTS[Math.floor(Math.random() * GHOSTS.length)] ?? 'Hollis Crane',
    level,
    prestige: 0,
    bounty: bountyForLevel(level),
    streak: 0,
    cowardice: 1,
    loadout: { ...GHOST_KIT },
    kind: 'ghost',
  }
}

// ---------------------------------------------------------------- rooms

interface RoomSeat {
  room: MockRoom
  seat: Seat
}
const roomTokens = new Map<string, RoomSeat>()
const rooms = new Map<string, { room: MockRoom; accounts: [Account | null, Account | null] }>()

function settleFor(id: string) {
  return {
    settle: (seat: Seat, won: boolean | null, outcome: string, ms: number | null): Settlement => {
      const r = rooms.get(id)
      const a = r?.accounts[seat] ?? null
      const opp = r?.room.posters[seat === 0 ? 1 : 0]
      const ghost = r?.room.mode === 'ghost'
      if (!(a && opp)) {
        return { delta: 0, xp: 0, purse: null, streak: 0, pairFactor: 1, lines: [] }
      }
      const lines: { label: string; amount: number; xp: number }[] = []
      const mine = poster(a)
      if (won === true) {
        const pay = duelPayout({ loserBounty: opp.bounty, reactionMs: ms, ghost })
        a.streak++
        lines.push({
          label: ghost ? `Ghost of ${opp.name}` : `Bounty on ${opp.name}`,
          amount: pay,
          xp: ghost ? 60 : 100,
        })
      } else if (won === false && outcome !== 'draw') {
        const pen = duelPenalty(a.purse, mine.bounty, { ghost, dodge: outcome === 'dodge' })
        a.streak = 0
        const xp = outcome === 'win' ? (ghost ? 24 : 40) : 0
        lines.push({
          label:
            outcome === 'win'
              ? 'Loss penalty'
              : `${outcome[0]?.toUpperCase()}${outcome.slice(1)} penalty`,
          amount: -pen,
          xp,
        })
      } else {
        lines.push({
          label: outcome === 'froze' ? 'Both froze' : 'Dead heat, twice',
          amount: 0,
          xp: outcome === 'froze' ? 25 : 50,
        })
      }
      const delta = lines.reduce((s, l) => s + l.amount, 0)
      const xp = lines.reduce((s, l) => s + l.xp, 0)
      grant(a, won === true ? (ghost ? 'ghost_win' : 'duel_win') : 'duel_loss', delta || 0, xp, id)
      return { delta, xp, purse: a.purse, streak: a.streak, pairFactor: 1, lines }
    },
  }
}

function openRoom(a: Account | null, b: Account | null, ghostLevel: number): [string, string] {
  const id = crypto.randomUUID().slice(0, 8)
  const posters: [Poster, Poster] = [
    a ? poster(a) : ghostPoster(ghostLevel),
    b ? poster(b) : ghostPoster(ghostLevel),
  ]
  const ghostSeat: Seat | null = a ? (b ? null : 1) : 0
  const room = new MockRoom(id, posters, ghostSeat, settleFor(id))
  rooms.set(id, { room, accounts: [a, b] })
  const t0 = crypto.randomUUID()
  const t1 = crypto.randomUUID()
  roomTokens.set(t0, { room, seat: 0 })
  roomTokens.set(t1, { room, seat: 1 })
  return [`ws://${ORIGIN}/duel/${id}/ws?token=${t0}`, `ws://${ORIGIN}/duel/${id}/ws?token=${t1}`]
}

// ---------------------------------------------------------------- queue

interface Waiting {
  ws: ServerWebSocket<WsData>
  account: Account
  since: number
  timer: ReturnType<typeof setInterval>
}
const queue: Waiting[] = []
const tickets = new Map<string, Account>()

function qsend(w: Waiting, m: QueueServerMessage): void {
  w.ws.send(JSON.stringify(m))
}

function unqueue(w: Waiting): void {
  clearInterval(w.timer)
  const i = queue.indexOf(w)
  if (i >= 0) {
    queue.splice(i, 1)
  }
}

function matchGhost(w: Waiting): void {
  unqueue(w)
  const level = levelProgress(w.account.xp).level
  const [url] = openRoom(w.account, null, level)
  const r = [...rooms.values()].at(-1)
  qsend(w, {
    type: 'matched',
    matchId: r?.room.id ?? '',
    mode: 'ghost',
    wsUrl: url,
    opponent: r?.room.posters[1] ?? ghostPoster(level),
  })
  w.ws.close()
}

function tryPair(w: Waiting): boolean {
  const other = queue.find((x) => x !== w && x.account.id !== w.account.id)
  if (!other) {
    return false
  }
  unqueue(w)
  unqueue(other)
  const [u0, u1] = openRoom(other.account, w.account, 1)
  const r = [...rooms.values()].at(-1)
  if (!r) {
    return false
  }
  qsend(other, {
    type: 'matched',
    matchId: r.room.id,
    mode: 'pvp',
    wsUrl: u0,
    opponent: r.room.posters[1],
  })
  qsend(w, {
    type: 'matched',
    matchId: r.room.id,
    mode: 'pvp',
    wsUrl: u1,
    opponent: r.room.posters[0],
  })
  other.ws.close()
  w.ws.close()
  return true
}

function joinQueue(ws: ServerWebSocket<WsData>, a: Account): void {
  const w: Waiting = {
    ws,
    account: a,
    since: Date.now(),
    timer: setInterval(() => statusTick(w), 1000),
  }
  ws.data.waiting = w
  queue.push(w)
  qsend(w, {
    type: 'queued',
    serverTime: Date.now(),
    effectiveLevel: levelProgress(a.xp).level,
    ghostsOnly: false,
  })
  tryPair(w)
}

function statusTick(w: Waiting): void {
  const waited = Date.now() - w.since
  if (waited >= 18_000) {
    matchGhost(w)
    return
  }
  const steps: [number, number, number | null][] = [
    [4000, 1, 25],
    [8000, 3, 50],
    [12_000, 6, null],
    [18_000, 12, null],
  ]
  const [, levelWindow, ratingWindow] = steps.find(([t]) => waited < t) ?? [0, 12, null]
  qsend(w, {
    type: 'status',
    serverTime: Date.now(),
    waitedMs: waited,
    waiting: queue.length,
    levelWindow,
    ratingWindow,
    ghostButton: waited >= 8000,
    ghostsOnly: false,
  })
}

// ---------------------------------------------------------------- HTTP

function cors(req: Request): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.get('origin') ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers':
      req.headers.get('access-control-request-headers') ?? 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  }
}

const json = (req: Request, body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: cors(req) })

const bearer = (req: Request): string | null =>
  req.headers.get('authorization')?.replace(/^Bearer /u, '') ?? null

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
}

async function signIn(req: Request): Promise<Response> {
  const b = await body(req)
  const name =
    String(b.name ?? '')
      .trim()
      .slice(0, 16) || `Drifter${Math.floor(Math.random() * 900 + 100)}`
  const id = crypto.randomUUID().slice(0, 12)
  const token = `dev:${id}:${name}`
  const a: Account = {
    id,
    name,
    purse: 0,
    xp: 0,
    streak: 0,
    owned: new Set(STARTER_ITEMS),
    loadout: { ...DEFAULT_LOADOUT },
    ledger: [],
  }
  grant(a, 'start_grant', 250, 0, null)
  // a little starting XP and cash so the Outfitter has something to show
  grant(a, 'admin_adjust', 4000, 1500, 'mock')
  accounts.set(token, a)
  const res = json(req, { token, player: { accountId: id, name } })
  // stream A's client restores its session from a refresh cookie: the mock's is the dev token
  res.headers.append('set-cookie', `ow_mock=${encodeURIComponent(token)}; Path=/; SameSite=Lax`)
  return res
}

/** Stream A's `POST /auth/refresh`, answered from the mock cookie. */
function refresh(req: Request): Response {
  const m = /(?:^|; )ow_mock=(?<tok>[^;]+)/u.exec(req.headers.get('cookie') ?? '')
  const tok = m?.groups?.tok
  const token = tok ? decodeURIComponent(tok) : null
  const a = account(token)
  if (!(a && token)) {
    return json(req, { ok: false, error: 'Signed out.' }, 401)
  }
  return json(req, {
    accessToken: token,
    expiresAt: Date.now() + 15 * 60_000,
    player: { accountId: a.id, name: a.name },
  })
}

async function buy(req: Request, a: Account): Promise<Response> {
  const b = await body(req)
  const item = itemById(String(b.itemId))
  if (!item) {
    return json(req, { ok: false, error: 'No such item.' }, 404)
  }
  const v = canBuy({ level: levelProgress(a.xp).level, purse: a.purse }, item, a.owned)
  const codes: Record<string, number> = { funds: 402, level: 403, not_for_sale: 403, owned: 409 }
  if (v !== 'ok') {
    return json(req, { ok: false, error: `Can't buy that (${v}).` }, codes[v] ?? 400)
  }
  a.owned.add(item.id)
  grant(a, 'store_purchase', -item.price, 0, item.id)
  return json(req, { ok: true, itemId: item.id, purse: a.purse, owned: [...a.owned] })
}

async function route(req: Request, url: URL): Promise<Response> {
  const a = account(bearer(req))
  const p = `${req.method} ${url.pathname}`
  if (p === 'POST /dev/sign-in') {
    return signIn(req)
  }
  if (p === 'POST /auth/refresh') {
    return refresh(req)
  }
  if (p === 'POST /auth/logout') {
    return json(req, { ok: true })
  }
  if (p === 'GET /duel/stats') {
    return json(req, {
      streak: a?.streak ?? 0,
      bestStreak: a?.streak ?? 0,
      wins: 0,
      losses: 0,
      draws: 0,
      cowardice: 0,
    })
  }
  if (p === 'GET /duel/settings' || p === 'PUT /duel/settings') {
    return json(req, {
      ghostOptOut: p.startsWith('PUT') ? Boolean((await body(req)).ghostOptOut) : false,
    })
  }
  if (p === 'GET /store') {
    return json(req, {
      catalogVersion: 1,
      items: CATALOG,
      owned: a ? [...a.owned] : [],
      purse: a?.purse ?? null,
      level: a ? levelProgress(a.xp).level : null,
    })
  }
  if (!a) {
    return json(req, { ok: false, error: 'Sign in first, partner.' }, 401)
  }
  switch (p) {
    case 'GET /me':
      return json(req, me(a))
    case 'GET /me/ledger':
      return json(req, { entries: a.ledger.slice(0, Number(url.searchParams.get('limit') ?? 20)) })
    case 'POST /store/buy':
      return buy(req, a)
    case 'PUT /me/loadout': {
      const l = (await body(req)).loadout
      const err = loadoutError(l, a.owned)
      if (err) {
        return json(req, { ok: false, error: err }, 400)
      }
      a.loadout = l as Loadout
      return json(req, { loadout: a.loadout })
    }
    case 'POST /queue/ticket': {
      const t = crypto.randomUUID()
      tickets.set(t, a)
      return json(req, { ticket: t, wsUrl: `ws://${ORIGIN}/queue/ws?ticket=${t}` })
    }
    default:
      return json(req, { ok: false, error: 'Not found' }, 404)
  }
}

interface WsData {
  kind: 'queue' | 'room'
  account?: Account
  seat?: RoomSeat
  waiting?: Waiting
}

Bun.serve<WsData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(req) })
    }
    if (url.pathname === '/queue/ws') {
      const a = tickets.get(url.searchParams.get('ticket') ?? '')
      tickets.delete(url.searchParams.get('ticket') ?? '')
      if (a && server.upgrade(req, { data: { kind: 'queue', account: a } })) {
        return
      }
      return new Response('bad ticket', { status: 401 })
    }
    if (/^\/duel\/[^/]+\/ws$/u.test(url.pathname)) {
      const seat = roomTokens.get(url.searchParams.get('token') ?? '')
      if (seat && server.upgrade(req, { data: { kind: 'room', seat } })) {
        return
      }
      return new Response('bad token', { status: 401 })
    }
    return route(req, url)
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === 'queue' && ws.data.account) {
        joinQueue(ws, ws.data.account)
      } else if (ws.data.seat) {
        ws.data.seat.room.join(ws.data.seat.seat, ws as ServerWebSocket<unknown>)
      }
    },
    message(ws, raw) {
      const text = String(raw)
      if (ws.data.kind === 'queue') {
        const m = JSON.parse(text) as { type: string }
        const w = ws.data.waiting
        if (w && m.type === 'ghost') {
          matchGhost(w)
        } else if (w && m.type === 'leave') {
          unqueue(w)
          ws.close()
        }
        return
      }
      ws.data.seat?.room.onMessage(ws.data.seat.seat, text)
    },
    close(ws) {
      if (ws.data.waiting) {
        unqueue(ws.data.waiting)
      }
      const s = ws.data.seat
      if (s && s.room.seats[s.seat].ws === (ws as ServerWebSocket<unknown>)) {
        s.room.leave(s.seat)
      }
    },
  },
})

console.log(`out west mock API on http://${ORIGIN}`)
