/**
 * Frontier lobby directory (a singleton, `dir:global`): always joinable via `lobby:0`, fills the
 * fullest lobby up to 28, rolls over at the cap, never moves players, forgets empty extra lobbies.
 * Joins are refused while the daily budget is spent. Owned by stream F. Rules: `registry.ts`.
 */
import { DurableObject } from 'cloudflare:workers'
import type { TownDirectoryView } from '../../../src/experiments/out-west/contract/town.ts'
import { budgetState, MAX_LOBBIES } from '../budget.ts'
import type { Env } from '../env.ts'
import { AdmissionLeases } from '../game/admission.ts'
import {
  type Assignment,
  assign,
  collect,
  emptyRegistry,
  type LobbyReport,
  occupancy,
  type Pool,
  poolOf,
  type RegistryState,
  report,
} from './registry.ts'

const KEY = 'registry'

export class LobbyDirectory extends DurableObject<Env> {
  private reg: RegistryState | null = null

  private async load(): Promise<RegistryState> {
    this.reg ??= (await this.ctx.storage.get<RegistryState>(KEY)) ?? emptyRegistry(Date.now())
    return this.reg
  }

  private async save(reg: RegistryState): Promise<void> {
    await this.ctx.storage.put(KEY, reg)
  }

  /** RPC admission lease, serialized atomically in this directory’s SQLite storage. */
  async leaseRoom(
    id: string,
    messages: number,
    finish = false,
    population?: { lobbyId: string; humans: number; accounts: string[] },
  ) {
    if (!Number.isSafeInteger(messages) || messages < 0 || id.length > 128) {
      throw new Error('Invalid room usage')
    }
    const grant = new AdmissionLeases(this.ctx.storage).renew(id, messages, finish)
    if (grant.ok && !finish && population) {
      const reg = await this.load()
      report(reg, {
        lobbyId: population.lobbyId,
        humans: population.humans,
        arrived: population.accounts,
        departed: [],
        now: grant.observedAt,
      })
      await this.save(reg)
    }
    return grant
  }

  /** Pick a lobby for an account (RPC from the join route). Flagged accounts ride in the Badlands. */
  async assign(accountId: string, preferred?: string, pool: Pool = 'main'): Promise<Assignment> {
    const reg = await this.load()
    const now = Date.now()
    collect(reg, now)
    const budget = await budgetState(this.env)
    const result = assign(reg, {
      accountId,
      now,
      preferred,
      budgetOpen: budget.frontierOpen,
      maxLobbies: MAX_LOBBIES,
      pool,
    })
    await this.save(reg)
    return result
  }

  /** Release an unconsumed assignment when global native admission refuses the room. */
  async cancelAssignment(lobbyId: string, accountId: string): Promise<void> {
    const reg = await this.load()
    const lobby = reg.lobbies[lobbyId]
    if (lobby) {
      delete lobby.reserved[accountId]
      await this.save(reg)
    }
  }

  /** A lobby's population changed (RPC from the Lobby DO, debounced to one per 5 s). */
  async report(r: Omit<LobbyReport, 'now'>): Promise<void> {
    const reg = await this.load()
    const now = Date.now()
    report(reg, { ...r, now })
    collect(reg, now)
    await this.save(reg)
  }

  async view(): Promise<TownDirectoryView> {
    const reg = await this.load()
    collect(reg, Date.now())
    const budget = await budgetState(this.env)
    return {
      // The Badlands is a shadow pool: never listed.
      lobbies: Object.values(reg.lobbies)
        .filter((e) => poolOf(e.id) === 'main')
        .map((e) => ({
          lobbyId: e.id,
          players: occupancy(e),
          state: e.state,
        })),
      open: budget.frontierOpen,
    }
  }
}
