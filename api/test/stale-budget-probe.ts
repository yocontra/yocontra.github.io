/** Deferred real budget query must never retire a replacement native room. */
import { CEILINGS } from '../src/budget.ts'
import type { Env } from '../src/env.ts'
import { createNativeRoom } from '../src/game/room.ts'
import { LobbyCore } from '../src/town/core.ts'
import type { Lobby } from '../src/town/lobby.ts'

export async function staleBudgetProbe(lobby: Lobby, env: Env, ctx: DurableObjectState) {
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const statement = (target: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(target, {
      get(original, key) {
        if (key === 'bind') {
          return (...values: unknown[]) => statement(original.bind(...values))
        }
        if (key === 'all') {
          return async () => {
            entered()
            await gate
            const result = await original.all()
            return {
              ...result,
              results: [{ metric: 'lobby_seconds', amount: CEILINGS.lobby_seconds }],
            }
          }
        }
        const value = Reflect.get(original, key)
        return typeof value === 'function' ? value.bind(original) : value
      },
    })
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) =>
          sql.startsWith('SELECT metric, amount FROM usage')
            ? statement(target.prepare(sql))
            : target.prepare(sql)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const pending: Promise<unknown>[] = []
  const context = new Proxy(ctx, {
    get(target, key) {
      if (key === 'waitUntil') {
        return (job: Promise<unknown>) => {
          pending.push(job)
          target.waitUntil(job)
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const old = new LobbyCore('lobby:999', 1)
  old.world.tick = 1200
  const replacement = new LobbyCore('lobby:999', 2)
  const native = await createNativeRoom({
    id: `${ctx.id.toString()}-replacement`,
    core: replacement,
    onTick: () => undefined,
  })
  Reflect.set(lobby, 'env', { ...env, DB: database })
  Reflect.set(lobby, 'ctx', context)
  Reflect.set(lobby, 'lobbyId', old.lobbyId)
  Reflect.set(lobby, 'core', old)
  try {
    Reflect.get(lobby, 'afterNativeStep').call(lobby, old)
    await reading
    Reflect.set(lobby, 'core', replacement)
    Reflect.set(lobby, 'native', native)
    release()
    await Promise.all(pending)
    if (Reflect.get(native, 'closed') || Reflect.get(lobby, 'core') !== replacement) {
      throw new Error('Stale budget continuation retired the replacement room')
    }
    return { replacementPreserved: true }
  } finally {
    release()
    Reflect.set(lobby, 'env', env)
    Reflect.set(lobby, 'ctx', ctx)
    Reflect.set(lobby, 'core', null)
    Reflect.set(lobby, 'native', undefined)
    await native.disconnect()
  }
}
