/** Voice-only workerd fixture: actual production admission/rooms, external RTK HTTP stubbed. */

import { DuelRoom as ProductionDuel } from '../src/duel/room.ts'
import type { Env } from '../src/env.ts'
import { reserveVoiceBudget } from '../src/voice/budget.ts'
import type { VoiceCoordinator, VoiceStorage } from '../src/voice/coordinator.ts'
import type { VoicePeer } from '../src/voice/proximity.ts'
import fixture, { Lobby as ProductionLobby } from './production-worker.ts'

export class Lobby extends ProductionLobby {
  private readonly voiceTrace: object[] = []
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const voice = Reflect.get(this, 'voice') as VoiceCoordinator
    const handle = voice.handle.bind(voice)
    voice.handle = (id, message) => {
      if (
        message &&
        typeof message === 'object' &&
        Reflect.get(message, 'type') === 'voice_talk' &&
        Reflect.get(message, 'talking') === false
      ) {
        const delay = Number(Reflect.get(env, 'VOICE_RELEASE_DELAY_MS')) || 0
        if (delay > 0) {
          this.voiceTrace.push({
            at: Date.now(),
            id,
            message,
            phase: 'release-in-transit',
            resources: voice.resources,
          })
          setTimeout(() => {
            handle(id, message)
            this.voiceTrace.push({
              at: Date.now(),
              id,
              message,
              phase: 'release-processed',
              resources: voice.resources,
            })
          }, delay)
          return true
        }
      }
      const result = handle(id, message)
      this.voiceTrace.push({
        at: Date.now(),
        id,
        message,
        phase: 'control-processed',
        resources: voice.resources,
      })
      return result
    }
  }
  voiceObservation() {
    const voice = Reflect.get(this, 'voice') as VoiceCoordinator
    return {
      resources: voice.resources,
      retryAt: voice.nextRetry,
      state: voice.snapshot(),
      trace: this.voiceTrace,
      peers: (Reflect.get(voice, 'o') as { peers: () => readonly VoicePeer[] }).peers(),
    }
  }
  placeVoicePeers() {
    const core = Reflect.get(this, 'core') as import('../src/town/core.ts').LobbyCore | null
    for (const player of core?.world.players ?? []) {
      if (player && !player.bot) {
        player.x = 70 + player.id
        player.z = 70
      }
    }
  }
}
export class DuelRoom extends ProductionDuel {
  async voiceAlarmDiscipline() {
    const deadline = Date.now() + 60_000
    Reflect.set(this, 'gameAlarmAt', deadline)
    await this.ctx.storage.put('gameAlarmAt', deadline)
    await this.alarm()
    const early = {
      flow: Boolean(Reflect.get(this, 'flow')),
      closed: Reflect.get(this, 'closed'),
      deadline: await this.ctx.storage.get('gameAlarmAt'),
    }
    await this.ctx.storage.put({ stored: 'old-game-marker', rest: 'old-rest-marker' })
    const voice: VoiceStorage = {
      cleanup: [
        {
          generation: 1,
          meetingId: 'duel-cleanup',
          participants: ['duel-token'],
          end: true,
          ended: false,
          retryAt: Date.now(),
          attempts: 0,
        },
      ],
    }
    const coordinator = Reflect.get(this, 'voice') as VoiceCoordinator
    await coordinator.restore(voice)
    Reflect.apply(Reflect.get(this, 'finishRoom'), this, [])
    return { early, deadline }
  }
  async voiceObservation() {
    const voice = Reflect.get(this, 'voice') as VoiceCoordinator
    return {
      resources: voice.resources,
      state: voice.snapshot(),
      keys: [...(await this.ctx.storage.list()).keys()],
      flow: Boolean(Reflect.get(this, 'flow')),
      pings: Reflect.get(this, 'pingTimer') !== undefined,
    }
  }
  restartVoice() {
    this.ctx.abort('Expected voice cold-alarm test restart')
  }
}

// biome-ignore lint/performance/noBarrelFile: Wrangler requires DO exports on the fixture entrypoint
export {
  DailySession,
  DuelSession,
  LobbyDirectory,
  Matchmaker,
  SettlementProbe,
} from './production-worker.ts'
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)
    if (url.pathname === '/__voice/budget') {
      return Response.json({
        allowed: await reserveVoiceBudget(
          env,
          Number(url.searchParams.get('count')),
          Number(url.searchParams.get('now')) || Date.now(),
        ),
      })
    }
    if (url.pathname.startsWith('/__voice/')) {
      const duel = url.searchParams.has('duel')
      const namespace = duel ? env.DUEL_ROOMS : env.LOBBIES
      const stub = namespace.get(
        namespace.idFromName(url.searchParams.get('lobbyId') ?? 'voice-duel'),
      )
      const method = (
        {
          '/__voice/observe': 'voiceObservation',
          '/__voice/place': 'placeVoicePeers',
          '/__voice/duel': 'voiceAlarmDiscipline',
          '/__voice/restart': 'restartVoice',
        } as Record<string, string>
      )[url.pathname]
      if (!method) {
        return new Response('Missing voice fixture method', { status: 404 })
      }
      return Response.json((await Reflect.apply(Reflect.get(stub, method), stub, [])) ?? null)
    }
    return fixture.fetch(request, env, ctx)
  },
}
