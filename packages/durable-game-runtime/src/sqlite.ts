/** Subset of SQLite-backed Durable Object storage used by the runtime. */
export interface DurableSqlStorage {
  sql: {
    exec: <Row extends Record<string, string | number | null>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) => { toArray: () => Row[] }
  }
}

export interface TransactionalDurableSqlStorage extends DurableSqlStorage {
  transactionSync: <T>(operation: () => T) => T
}
