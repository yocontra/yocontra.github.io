/**
 * Local integration fixture. Never used by the production Wrangler configuration.
 * From the repository root, using the supported Node version:
 * bun x wrangler d1 migrations apply out-west-native-test --local --config api/test/wrangler.native-test.jsonc
 * bun x wrangler dev --local --config api/test/wrangler.native-test.jsonc --port 8792 --inspector-port 9232
 * The tracked browser harnesses use OW_API=http://127.0.0.1:8792 and a client on4390.
 */

import { activePlayers } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { signAccessToken } from '../src/auth/token.ts'
import { createProfileStatements } from '../src/economy/profile.ts'
import type { Env } from '../src/env.ts'
import type { NativeFrontierRoom } from '../src/game/room.ts'
import worker from '../src/index.ts'
import type { LobbyCore } from '../src/town/core.ts'
import { Lobby as ProductionLobby } from '../src/town/lobby.ts'
import type { SettlementProbe } from './settlement-worker.ts'
import { staleBudgetProbe } from './stale-budget-probe.ts'
import { observeTimers, ownedTimers } from './timers.ts'

/** Read-only lifecycle observation; this subclass is absent from the production entrypoint. */
export class Lobby extends ProductionLobby {
  override reserveNative(...args: Parameters<ProductionLobby['reserveNative']>) {
    return observeTimers(this.ctx.id.toString(), () => super.reserveNative(...args))
  }
  override fetch(request: Request) {
    return observeTimers(this.ctx.id.toString(), () => super.fetch(request))
  }
  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    return observeTimers(this.ctx.id.toString(), () => super.webSocketClose(socket, code, reason))
  }
  testStaleBudget() {
    return staleBudgetProbe(this, this.env, this.ctx)
  }
  private observedRoom: NativeFrontierRoom | undefined
  private readonly instance = crypto.randomUUID()
  testRestart() {
    this.ctx.abort('Fixture cold seat restart')
  }
  async testTiming() {
    const current = Reflect.get(this, 'native') as NativeFrontierRoom | undefined
    this.observedRoom = current ?? this.observedRoom
    return {
      instance: this.instance,
      timers: ownedTimers(this.ctx.id.toString()),
      active: Boolean(current),
      core: Boolean(Reflect.get(this, 'core')),
      physics: Boolean(current && Reflect.get(current, 'simulation')),
      bots: ((Reflect.get(this, 'core') as LobbyCore | undefined)?.world.players ?? []).filter(
        (player) => player?.bot && !player.gone,
      ).length,
      humans: (Reflect.get(this, 'core') as LobbyCore | undefined)?.connectedHumans() ?? 0,
      seats:
        this.ctx.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM native_seats')
          .toArray()[0]?.count ?? 0,
      alarm: await this.ctx.storage.getAlarm(),
      tick: current?.state.tick ?? 0,
      timer: this.observedRoom
        ? Reflect.get(this.observedRoom, '_simulationInterval') !== undefined
        : false,
      running: this.observedRoom?.clock.running ?? false,
      cleanup: Reflect.get(this, 'nativeCleanup') !== undefined,
      leaseTimer: Reflect.get(this, 'nativeLeaseTimer') !== undefined,
      lease: Boolean(Reflect.get(this, 'nativeLeaseId')),
    }
  }
  /** Same packed scene as loopback; AI and native movement remain on the actual room timer. */
  async testPackedTown(accountId: string) {
    const core = Reflect.get(this, 'core') as LobbyCore | undefined
    const session = [...(core?.sessions.values() ?? [])].find(
      (candidate) => candidate.accountId === accountId && candidate.peer,
    )
    if (!(core && session) || core.connectedHumans() !== 1) {
      return { ok: false as const, error: 'Join with exactly one fixture human first.' }
    }
    const self = core.world.players[session.playerId]
    if (!self) {
      return { ok: false as const, error: 'The fixture rider has left.' }
    }
    // Deliberate synthetic stress only; the production constructor remains capped at four.
    Reflect.set(core, 'maxBots', 31)
    core.botTarget = 31
    core.ambientPopulation = 32
    core.bots.rally = self.id
    for (
      let attempt = 0;
      attempt < 240 && [...activePlayers(core.world)].filter((player) => player.bot).length < 31;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const population = [...activePlayers(core.world)]
    if (
      core.connectedHumans() !== 1 ||
      population.length !== 32 ||
      population.filter((player) => player.bot).length !== 31
    ) {
      return { ok: false as const, error: 'The native room did not reach one human and31 bots.' }
    }
    self.x = 72
    self.z = 66
    for (const player of activePlayers(core.world)) {
      if (player.bot) {
        const angle = player.id * 2.399_963
        const radius = 4 + (player.id % 6)
        player.x = self.x + Math.cos(angle) * radius
        player.z = self.z + Math.sin(angle) * radius
      }
      player.y = 0
      // The existing spawn-generation path restores each native capsule at its exact new pose.
      player.spawnTick = core.world.tick + 1
    }
    await new Promise((resolve) => setTimeout(resolve, 75))
    const players = [...activePlayers(core.world)]
    return {
      ok: true as const,
      lobbyId: core.lobbyId,
      tick: core.world.tick,
      players: players.length,
      bots: players.filter((player) => player.bot).length,
      humans: core.connectedHumans(),
      selfSlot: self.id,
      spawn: { x: self.x, y: self.y, z: self.z },
    }
  }
}

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object class exports from its entrypoint
export {
  DailySession,
  DuelRoom,
  DuelSession,
  Matchmaker,
} from '../src/index.ts'
export { LobbyDirectory } from './directory-probe.ts'
export { SettlementProbe } from './settlement-worker.ts'
export default {
  async fetch(
    request: Request,
    env: Env & { SETTLEMENT?: DurableObjectNamespace<SettlementProbe> },
    ctx: ExecutionContext,
  ) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/__test/stale-native-budget') {
      const lobby = env.LOBBIES.get(env.LOBBIES.idFromName('stale-budget-probe'))
      return Response.json(await Reflect.apply(Reflect.get(lobby, 'testStaleBudget'), lobby, []))
    }
    if (pathname === '/__test/delay-native-lease' || pathname === '/__test/native-leases') {
      const directory = env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName('dir:global'))
      if (pathname === '/__test/delay-native-lease') {
        await Reflect.apply(Reflect.get(directory, 'testDelayLease'), directory, [500])
        return Response.json({ armed: true })
      }
      return Response.json(await Reflect.apply(Reflect.get(directory, 'testLeases'), directory, []))
    }
    if (pathname === '/__test/packed-town' && request.method === 'POST') {
      const value = (await request.json()) as { lobbyId?: unknown; accountId?: unknown }
      if (typeof value.lobbyId !== 'string' || typeof value.accountId !== 'string') {
        return Response.json({ error: 'Expected fixture lobbyId and accountId.' }, { status: 400 })
      }
      const lobby = env.LOBBIES.get(env.LOBBIES.idFromName(value.lobbyId))
      const result = (await Reflect.apply(Reflect.get(lobby, 'testPackedTown'), lobby, [
        value.accountId,
      ])) as Awaited<ReturnType<Lobby['testPackedTown']>>
      return Response.json(result, { status: result.ok ? 200 : 409 })
    }
    if (pathname === '/__test/restart-native') {
      const id = new URL(request.url).searchParams.get('lobbyId') ?? ''
      const lobby = env.LOBBIES.get(env.LOBBIES.idFromName(id))
      await Reflect.apply(Reflect.get(lobby, 'testRestart'), lobby, [])
      return Response.json({ restarted: true })
    }
    if (pathname === '/__test/native-timing') {
      const id = new URL(request.url).searchParams.get('lobbyId') ?? ''
      const lobby = env.LOBBIES.get(env.LOBBIES.idFromName(id))
      return Response.json(await Reflect.apply(Reflect.get(lobby, 'testTiming'), lobby, []))
    }
    if (
      ['/__test/settlement', '/__test/orphan-socket', '/__test/restart-settlement'].includes(
        pathname,
      ) &&
      env.SETTLEMENT
    ) {
      const probe = env.SETTLEMENT.get(env.SETTLEMENT.idFromName('settlement'))
      return probe.fetch(request)
    }
    if (pathname === '/__test/exhaust') {
      const directory = env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName('dir:global'))
      const id = `test-exhaust-${crypto.randomUUID()}`
      await directory.leaseRoom(id, 0)
      await directory.leaseRoom(id, 1_200_000, true)
      return Response.json({ ok: true })
    }
    if (pathname === '/__test/seed') {
      const id = crypto.randomUUID()
      const name = `Rider${id.slice(0, 6)}`
      await env.DB.prepare('INSERT INTO accounts(id,name,name_key,created_at) VALUES(?,?,?,?)')
        .bind(id, name, name.toLowerCase(), Date.now())
        .run()
      await env.DB.batch(createProfileStatements(env, id))
      await env.DB.prepare('UPDATE profiles SET gauntlet_clears=7 WHERE account_id=?')
        .bind(id)
        .run()
      const access = await signAccessToken(env.AUTH_SECRET, {
        accountId: id,
        name,
        sid: crypto.randomUUID(),
        platform: 'web',
        authTime: Date.now(),
      })
      return Response.json({ accountId: id, name, ...access })
    }
    return worker.fetch(request, env, ctx)
  },
}
