import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'

const destinations = new AsyncLocalStorage<string>()

/** Preview authoring can stage every derivative outside the site's published public tree. */
export function contentOutput(...path: string[]): string {
  return resolve(destinations.getStore() ?? 'public/experiments/out-west/3d/native-v2', ...path)
}

/** Scope a concurrent offline bake without changing another author's destination. */
export function withContentOutput<T>(directory: string, bake: () => Promise<T>): Promise<T> {
  return destinations.run(resolve(directory), bake)
}
