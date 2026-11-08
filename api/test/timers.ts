/** Fixture-only timer ownership observation through Workers AsyncLocalStorage. */
import { AsyncLocalStorage } from 'node:async_hooks'

const scope = new AsyncLocalStorage<string>()
const timers = new Map<unknown, { owner: string; kind: string; delay: number; stack?: string }>()
const timeout = globalThis.setTimeout
const interval = globalThis.setInterval
const clearTimer = globalThis.clearTimeout
const clearRepeater = globalThis.clearInterval
const observeTimeout = (handler: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
  const owner = scope.getStore()
  let id: ReturnType<typeof timeout>
  id = timeout(() => {
    timers.delete(id)
    handler(...args)
  }, delay)
  if (owner) {
    timers.set(id, { owner, kind: 'timeout', delay })
  }
  return id
}
const observeInterval = (handler: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
  const id = interval(handler, delay, ...args)
  const owner = scope.getStore()
  if (owner) {
    timers.set(id, {
      owner,
      kind: 'interval',
      delay,
      stack: new Error('Fixture interval allocation').stack ?? '',
    })
  }
  return id
}
Reflect.set(globalThis, 'setTimeout', observeTimeout)
Reflect.set(globalThis, 'setInterval', observeInterval)
globalThis.clearTimeout = (id) => {
  timers.delete(id)
  Reflect.apply(clearTimer, globalThis, [id])
}
globalThis.clearInterval = (id) => {
  timers.delete(id)
  Reflect.apply(clearRepeater, globalThis, [id])
}
export function observeTimers<T>(owner: string, operation: () => T): T {
  return scope.run(owner, operation)
}
export function ownedTimers(owner: string) {
  return [...timers.values()].filter((timer) => timer.owner === owner)
}
