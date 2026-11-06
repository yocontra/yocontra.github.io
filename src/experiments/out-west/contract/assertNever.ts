/**
 * Compile-time exhaustiveness. Call it in the `default` of a switch over a closed union: the
 * argument is `never` only when every case is handled, so adding a union member fails the build
 * until the switch (or this call) is updated.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`)
}
