/**
 * Migration 0011 rebuilds the ledger to add the XP-only standoff kinds. Existing rows must come
 * through unchanged (ids, amounts, balances, keys, the AUTOINCREMENT sequence) except the kind of
 * old standoff rows, and the ledger must keep working afterwards.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(import.meta.dir, '..', '..', 'migrations')
const TARGET = '0011_ledger_standoff_kinds.sql'
const CHECK_FAILED = /CHECK/u
const UNIQUE_FAILED = /UNIQUE/u

function dbBefore(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  return db
}

interface Row {
  id: number
  account_id: string
  delta: number
  xp: number
  balance_after: number
  kind: string
  ref: string | null
  idem_key: string
  batch: string
  created_at: number
}

function seed(db: Database): void {
  const now = 1_793_000_000_000
  for (const id of ['acct-a', 'acct-b', 'acct-gone']) {
    db.query('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      id,
      id.replace('-', ''),
      now,
    )
  }
  const match = (id: string, outcome: string, winner: string | null) =>
    db
      .query(
        `INSERT INTO matches (id, mode, a_id, b_id, winner, outcome, a_delta, b_delta, a_xp, b_xp,
           pair_factor, started_at, ended_at)
         VALUES (?, 'pvp', 'acct-a', 'acct-b', ?, ?, 0, 0, 0, 0, 1, ?, ?)`,
      )
      .run(id, winner, outcome, now, now)
  match('room1:0', 'win', 'a')
  match('room1:1', 'froze', null)
  match('room2:0', 'draw', null)
  const row = (r: Omit<Row, 'id' | 'batch' | 'created_at'>) =>
    db
      .query(
        `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'b', ?)`,
      )
      .run(r.account_id, r.delta, r.xp, r.balance_after, r.kind, r.ref, r.idem_key, now)
  row({
    account_id: 'acct-a',
    delta: 250,
    xp: 0,
    balance_after: 250,
    kind: 'start_grant',
    ref: null,
    idem_key: 'start:a#0',
  })
  row({
    account_id: 'acct-a',
    delta: 40,
    xp: 60,
    balance_after: 290,
    kind: 'duel_win',
    ref: 'room1:0',
    idem_key: 'match:room1:0#0',
  })
  row({
    account_id: 'acct-a',
    delta: 10,
    xp: 0,
    balance_after: 300,
    kind: 'duel_win',
    ref: 'room1:0:streak',
    idem_key: 'match:room1:0#1',
  })
  row({
    account_id: 'acct-b',
    delta: -20,
    xp: 15,
    balance_after: 230,
    kind: 'duel_loss',
    ref: 'room1:0',
    idem_key: 'match:room1:0#2',
  })
  row({
    account_id: 'acct-a',
    delta: 0,
    xp: 25,
    balance_after: 300,
    kind: 'duel_win',
    ref: 'room1:1',
    idem_key: 'match:room1:1#0',
  })
  row({
    account_id: 'acct-b',
    delta: 0,
    xp: 25,
    balance_after: 230,
    kind: 'duel_win',
    ref: 'room1:1',
    idem_key: 'match:room1:1#1',
  })
  row({
    account_id: 'acct-a',
    delta: 0,
    xp: 50,
    balance_after: 300,
    kind: 'duel_win',
    ref: 'room2:0',
    idem_key: 'match:room2:0#0',
  })
  // a $0 win that isn't a standoff (a capped ghost win would look like this): stays a win
  row({
    account_id: 'acct-a',
    delta: 0,
    xp: 30,
    balance_after: 300,
    kind: 'duel_win',
    ref: 'other',
    idem_key: 'match:other#0',
  })
  row({
    account_id: 'acct-gone',
    delta: 250,
    xp: 0,
    balance_after: 250,
    kind: 'start_grant',
    ref: null,
    idem_key: 'start:gone#0',
  })
  // the newest rows belonged to an account that was deleted: AUTOINCREMENT must not reuse its id
  db.query("DELETE FROM accounts WHERE id = 'acct-gone'").run()
}

const all = (db: Database): Row[] => db.query('SELECT * FROM ledger ORDER BY id').all() as Row[]

describe('migration 0011: standoff ledger kinds', () => {
  it('copies every row unchanged except the kind of old standoff rows', () => {
    const db = dbBefore()
    seed(db)
    const before = all(db)
    const seqBefore = db.query("SELECT seq FROM sqlite_sequence WHERE name = 'ledger'").get()
    db.exec(readFileSync(join(MIGRATIONS, TARGET), 'utf8'))
    const after = all(db)

    const relabelled: Record<string, string> = {
      'match:room1:1#0': 'duel_froze',
      'match:room1:1#1': 'duel_froze',
      'match:room2:0#0': 'duel_draw',
    }
    expect(after).toEqual(before.map((r) => ({ ...r, kind: relabelled[r.idem_key] ?? r.kind })))
    expect(db.query("SELECT seq FROM sqlite_sequence WHERE name = 'ledger'").get()).toEqual(
      seqBefore,
    )
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger'")
      .all() as { name: string }[]
    expect(new Set(indexes.map((i) => i.name))).toEqual(
      new Set(['ledger_account', 'ledger_account_kind', 'sqlite_autoindex_ledger_1']),
    )
  })

  it('keeps the constraints, takes the new kinds, and keeps the account cascade', () => {
    const db = dbBefore()
    seed(db)
    db.exec(readFileSync(join(MIGRATIONS, TARGET), 'utf8'))
    const insert = db.query(
      `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
       VALUES ('acct-a', 0, ?, 300, ?, 'r', ?, 'b', 1)`,
    )
    insert.run(25, 'duel_froze', 'new#0')
    insert.run(50, 'duel_draw', 'new#1')
    const newest = db.query("SELECT id FROM ledger WHERE idem_key = 'new#0'").get() as {
      id: number
    }
    expect(newest.id).toBe(10)
    expect(() => insert.run(25, 'bogus', 'new#2')).toThrow(CHECK_FAILED)
    expect(() => insert.run(25, 'duel_draw', 'new#0')).toThrow(UNIQUE_FAILED)
    expect(() => insert.run(0, 'duel_draw', 'new#3')).toThrow(CHECK_FAILED)
    db.query("DELETE FROM accounts WHERE id = 'acct-b'").run()
    expect(db.query("SELECT COUNT(*) AS n FROM ledger WHERE account_id = 'acct-b'").get()).toEqual({
      n: 0,
    })
  })
})
