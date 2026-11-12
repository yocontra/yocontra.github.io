import { Moments } from '../../src/experiments/out-west/duel/native-moments.ts'

const noop = () => undefined

/** `known` as given; any other member is a no-op call (presentation the duel tests don't observe). */
export function quiet<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : noop),
  })
}

/** The director's presentation state, inert: camera rig, dust, mugshots and the moment's state. */
export function inertPresentation() {
  return {
    m: new Moments(),
    rig: quiet({ name: '', reduced: false }),
    dust: quiet({}),
    portraits: { print: () => Promise.resolve(null) },
  }
}
