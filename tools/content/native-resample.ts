/** Bound key reduction tightly enough to preserve PlayCanvas's native gun paths. */
import type { Transform } from '@gltf-transform/core'
import { resample } from '@gltf-transform/functions'

/** The reducer uses SLERP; native graph tests cover its normalized-linear playback. */
export function resampleNative(): Transform {
  return resample({ tolerance: 0.000_000_1 })
}
