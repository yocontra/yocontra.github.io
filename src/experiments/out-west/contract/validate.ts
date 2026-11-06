/** Shared runtime narrowing for values that arrive as `unknown` (JSON, storage, native bridges). */

/** A plain object with string keys: the start of every hand-written validator. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
