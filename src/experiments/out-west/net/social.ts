/**
 * The social and money-sink calls: the Most Wanted board, public posters, reports and blocks, the
 * name change, the house round, dye jobs, prestige and the "while you were away" notice. Shapes
 * in `wire-social.ts`. Every call resolves to a typed result and never throws.
 */
import type { MeResponse } from '../contract/economy.ts'
import type { ItemId } from '../data/catalog.ts'
import { apiJson } from './api.ts'
import type { Result } from './leaderboard.ts'
import type {
  BlocksResponse,
  ChalkboardResponse,
  DyeId,
  DyeResponse,
  MostWantedResponse,
  NameChangeResponse,
  PlayerPoster,
  ReportReason,
  ReportResponse,
  RoundResponse,
} from './wire-social.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const okTrue = (v: unknown): v is Record<string, unknown> & { ok: true } =>
  isRecord(v) && v.ok === true

/** A nonce so a retried tap can't buy twice (8–64 chars). */
const requestId = (): string => crypto.randomUUID()

const playerPath = (name: string): string => `/players/${encodeURIComponent(name)}`

export const fetchMostWanted = (month?: string): Promise<Result<MostWantedResponse>> =>
  apiJson(
    `/board/most-wanted?limit=25${month ? `&month=${encodeURIComponent(month)}` : ''}`,
    {},
    (v): v is MostWantedResponse =>
      isRecord(v) && typeof v.month === 'string' && Array.isArray(v.rows) && isRecord(v.previous),
  )

export const fetchPoster = (name: string): Promise<Result<PlayerPoster>> =>
  apiJson(
    playerPath(name),
    {},
    (v): v is PlayerPoster =>
      isRecord(v) && typeof v.name === 'string' && isRecord(v.duel) && isRecord(v.frontier),
  )

export const fetchChalkboard = (): Promise<Result<ChalkboardResponse>> =>
  apiJson(
    '/saloon/chalkboard',
    {},
    (v): v is ChalkboardResponse => isRecord(v) && Array.isArray(v.rounds),
  )

export const buyRound = (): Promise<Result<RoundResponse>> =>
  apiJson(
    '/saloon/round',
    { body: { requestId: requestId() } },
    (v): v is RoundResponse => okTrue(v) && Array.isArray(v.rounds),
  )

export const changeName = (name: string): Promise<Result<NameChangeResponse>> =>
  apiJson(
    '/me/name',
    { body: { name } },
    (v): v is NameChangeResponse => okTrue(v) && typeof v.name === 'string',
  )

export const report = (o: {
  name: string
  reason: ReportReason
  context?: string
  block: boolean
}): Promise<Result<ReportResponse>> =>
  apiJson(
    '/reports',
    { body: o },
    (v): v is ReportResponse => okTrue(v) && typeof v.blocked === 'boolean',
  )

const isBlocks = (v: unknown): v is BlocksResponse => okTrue(v) && Array.isArray(v.blocked)

export const fetchBlocks = (): Promise<Result<BlocksResponse>> => apiJson('/blocks', {}, isBlocks)

export const block = (name: string): Promise<Result<BlocksResponse>> =>
  apiJson('/blocks', { body: { name } }, isBlocks)

export const unblock = (name: string): Promise<Result<BlocksResponse>> =>
  apiJson(`/blocks/${encodeURIComponent(name)}`, { method: 'DELETE' }, isBlocks)

export const dyeItem = (itemId: ItemId, dye: DyeId): Promise<Result<DyeResponse>> =>
  apiJson(
    '/store/dye',
    { body: { itemId, dye, requestId: requestId() } },
    (v): v is DyeResponse => okTrue(v) && isRecord(v.dyes) && typeof v.purse === 'number',
  )

export const prestige = (): Promise<Result<MeResponse>> =>
  apiJson(
    '/me/prestige',
    { body: {} },
    (v): v is MeResponse => isRecord(v) && typeof v.level === 'number' && typeof v.xp === 'number',
  )

/** Dismiss the "while you were away" notice up to `asOf` (the report's own). */
export const ackAway = (asOf: number): Promise<Result<unknown>> =>
  apiJson('/me/away/ack', { body: { asOf } }, (v): v is unknown => v !== undefined)

/** Your block list, cached for the page: blocked players are never shown (chalkboard, call-outs). */
let blockedCache: Promise<Set<string>> | null = null

export function blockedNames(): Promise<Set<string>> {
  blockedCache ??= fetchBlocks().then((r) =>
    r.ok ? new Set(r.value.blocked.map((n) => n.toLowerCase())) : new Set<string>(),
  )
  return blockedCache
}

/** After a block or unblock, the next read fetches the list again (or takes this one). */
export function setBlocked(list: readonly string[] | null): void {
  blockedCache = list ? Promise.resolve(new Set(list.map((n) => n.toLowerCase()))) : null
}
