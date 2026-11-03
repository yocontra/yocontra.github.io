/** Finding a player by their display name (the lookup is by name key). */
import type { Env } from '../env.ts'
import { nameKey } from '../names.ts'

export interface NamedAccount {
  id: string
  name: string
  flags: number
  createdAt: number
}

export async function accountByName(env: Env, raw: unknown): Promise<NamedAccount | null> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    return null
  }
  const key = nameKey(raw)
  if (key === '') {
    return null
  }
  const row = await env.DB.prepare(
    'SELECT id, name, flags, created_at FROM accounts WHERE name_key = ?',
  )
    .bind(key)
    .first<{ id: string; name: string; flags: number; created_at: number }>()
  return row ? { id: row.id, name: row.name, flags: row.flags, createdAt: row.created_at } : null
}
