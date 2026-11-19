/**
 * Test harness: a fresh in-memory local D1 (workerd) with every migration in
 * `api/migrations` applied in order. Test-only; never imported by the Worker.
 *
 * Until stream A's `0003` lands, a minimal local-only `accounts (id, name)` table stands in for it
 * so the foreign keys in `0004` resolve. It's created here, never in a migration.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import type { Env } from '../../env.ts'

const MIGRATIONS = join(import.meta.dir, '../../../migrations')
const STATEMENT_END = /;\s*$/mu
const COMMENT_LINE = /^\s*--.*$/gmu

export interface TestDb {
  db: D1Database
  env: Env
  dispose: () => Promise<void>
}

function statementsOf(sql: string): string[] {
  return sql
    .replace(COMMENT_LINE, '')
    .split(STATEMENT_END)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

async function openDatabase(retry = true): Promise<{ db: D1Database; runtime: Miniflare }> {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch: () => new Response(null, { status: 404 }) }',
      compatibilityDate: '2026-10-01',
      d1Databases: { DB: '00000000-0000-0000-0000-00000000000c' },
      d1Persist: false,
    }),
  )
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    return { db, runtime }
  } catch (error) {
    try {
      await runtime.dispose()
    } catch (cleanupError) {
      // Miniflare can rethrow the rejected startup promise after it finishes disposal.
      if (cleanupError !== error) {
        throw new AggregateError([error, cleanupError], 'Local D1 startup and disposal failed')
      }
    }
    if (
      retry &&
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'ERR_ASSERTION' &&
      error.stack?.includes('at getServerPort') &&
      error.stack.includes('miniflare')
    ) {
      // The loopback listener can report readiness before its address is available under Bun.
      return openDatabase(false)
    }
    throw error
  }
}

async function migrate(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const hasAccounts = files.some((f) => f.startsWith('0003_'))
  for (const file of files) {
    if (!hasAccounts && file.startsWith('0004_')) {
      // biome-ignore lint/performance/noAwaitInLoops: migrations apply strictly in order
      await db.prepare('CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)').run()
    }
    const statements = statementsOf(readFileSync(join(MIGRATIONS, file), 'utf8'))
    await db.batch(statements.map((s) => db.prepare(s)))
  }
}

export async function testDb(): Promise<TestDb> {
  const { db, runtime } = await openDatabase()
  try {
    await migrate(db)
  } catch (error) {
    try {
      await runtime.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Local D1 migration and disposal failed')
    }
    throw error
  }
  const env = {
    DB: db,
    ALLOWED_ORIGINS: 'http://localhost:4343',
    TURNSTILE_SECRET: '',
    AUTH_SECRET: 'test-secret-for-economy-route-tests-only-0123456789',
    RP_ID: 'localhost',
    RP_ORIGINS: 'http://localhost:4343',
  } as unknown as Env
  return { db, env, dispose: () => runtime.dispose() }
}

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

/** Inserts an account row, filling any NOT NULL columns stream A's real table may add. */
export async function insertAccount(db: D1Database, id: string, name: string): Promise<void> {
  const { results } = await db.prepare('PRAGMA table_info(accounts)').all<ColumnInfo>()
  const names: string[] = []
  const values: unknown[] = []
  for (const col of results) {
    if (col.name === 'id') {
      names.push('id')
      values.push(id)
    } else if (col.name === 'name') {
      names.push('name')
      values.push(name)
    } else if (col.notnull === 1 && col.dflt_value === null) {
      names.push(col.name)
      values.push(col.type.toUpperCase().includes('INT') ? Date.now() : `${col.name}:${id}`)
    }
  }
  await db
    .prepare(
      `INSERT INTO accounts (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .bind(...values)
    .run()
}

let counter = 0
/** A unique account id for one test. */
export const freshId = (prefix = 'acct'): string => `${prefix}-${Date.now()}-${++counter}`
