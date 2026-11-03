/**
 * Test-only: a tiny D1Database over `bun:sqlite`, loaded with the real migrations, so auth tests run
 * the same SQL the Worker does. Implements just the surface auth uses: prepare/bind/first/all/run
 * and an atomic batch. Never imported by the Worker. Owned by stream A.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Env } from '../env.ts'

const MIGRATIONS = join(import.meta.dir, '..', '..', 'migrations')
const RETURNS_ROWS = /^\s*(?:select|with)\b|\breturning\b/iu
const IS_QUERY = /^\s*(?:select|with)\b/iu

interface Result {
  results: unknown[]
  success: true
  meta: { changes: number }
}

class FakeStatement {
  readonly db: Database
  readonly sql: string
  readonly params: SQLQueryBindings[]

  constructor(db: Database, sql: string, params: SQLQueryBindings[] = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values as SQLQueryBindings[])
  }

  exec(): Result {
    const stmt = this.db.prepare(this.sql)
    if (RETURNS_ROWS.test(this.sql)) {
      const rows = stmt.all(...this.params)
      const changes = IS_QUERY.test(this.sql) ? 0 : rows.length
      return { results: rows, success: true, meta: { changes } }
    }
    const info = stmt.run(...this.params)
    return { results: [], success: true, meta: { changes: info.changes } }
  }

  // biome-ignore lint/suspicious/useAwait: mirrors D1's async API
  async first<T>(): Promise<T | null> {
    return (this.exec().results[0] as T | undefined) ?? null
  }

  // biome-ignore lint/suspicious/useAwait: mirrors D1's async API
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.exec().results as T[] }
  }

  // biome-ignore lint/suspicious/useAwait: mirrors D1's async API
  async run(): Promise<Result> {
    return this.exec()
  }
}

export interface FakeD1 {
  db: Database
  d1: D1Database
}

export function fakeD1(): FakeD1 {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  const d1 = {
    prepare: (sql: string) => new FakeStatement(db, sql),
    batch: (stmts: FakeStatement[]) =>
      Promise.resolve(db.transaction(() => stmts.map((s) => s.exec()))()),
  }
  return { db, d1: d1 as unknown as D1Database }
}

export const TEST_SECRET = 'test-secret-at-least-16-chars'

/** An Env with a fake D1 and test auth settings. Other bindings are absent. */
export function fakeEnv(overrides: Partial<Env> = {}): Env & { sqlite: Database } {
  const { db, d1 } = fakeD1()
  return {
    DB: d1,
    ALLOWED_ORIGINS: 'http://localhost:4341',
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    AUTH_SECRET: TEST_SECRET,
    RP_ID: 'localhost',
    RP_ORIGINS: 'http://localhost:4341',
    ...overrides,
    sqlite: db,
  } as Env & { sqlite: Database }
}

/** Inserts a bare account row (tests that don't need a passkey ceremony). */
export function seedAccount(env: { sqlite: Database }, id: string, name: string): void {
  env.sqlite
    .prepare('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name, name.toLowerCase().replace(/[^a-z0-9]/gu, ''), Date.now())
}
