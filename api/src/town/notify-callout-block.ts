import type { Env } from '../env.ts'

async function refresh(env: Env, accountA: string, accountB: string): Promise<void> {
  const directory = env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName('dir:global'))
  const rooms = await directory.calloutBlockRooms()
  await Promise.all(
    rooms.map((id) =>
      env.LOBBIES.get(env.LOBBIES.idFromName(id)).refreshCalloutBlock(accountA, accountB),
    ),
  )
}

/**
 * Apply a committed block before acknowledging it when rooms are available. Keep D1's successful
 * response for the local block list even if delivery fails, and retry with fresh RPC stubs.
 */
export async function notifyCalloutBlock(
  env: Env,
  ctx: ExecutionContext,
  accountA: string,
  accountB: string,
): Promise<void> {
  try {
    await refresh(env, accountA, accountB)
  } catch {
    ctx.waitUntil(
      refresh(env, accountA, accountB).catch((err: unknown) => {
        console.warn('Frontier call-out block refresh failed', err)
      }),
    )
  }
}
