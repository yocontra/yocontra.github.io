/**
 * A monomorphic fast path for `Matrix4.toArray` into a Float32Array.
 *
 * three.js calls `toArray` from everywhere: plain arrays, Float32Arrays, Float64Arrays. Its store
 * sites go megamorphic, and V8 then boxes every double it copies (a heap number per element).
 * In Frontier the hot callers are `Skeleton.update` (52 bones × 16 floats per skinned rider per
 * frame) and `InstancedMesh.setMatrixAt` (the VAT crowd, hats, blob shadows, fx): measured at
 * ~7.7 KB of garbage per skeleton update, megabytes a second in a busy town. The Float32Array
 * branch below only ever sees Float32Arrays, so it stays monomorphic and allocates nothing.
 * Same values out; anything else falls through to three's own method.
 */
import { Matrix4 } from 'three'

type ToArray = (array?: ArrayLike<number> | number[], offset?: number) => ArrayLike<number>

const FLAG = Symbol.for('out-west.fast-to-array')

export function installHotPaths(): void {
  const proto = Matrix4.prototype
  if (Reflect.get(proto, FLAG) === true) {
    return
  }
  const generic = Reflect.get(proto, 'toArray') as ToArray
  const fast = function (this: Matrix4, array?: ArrayLike<number>, offset = 0): ArrayLike<number> {
    if (array instanceof Float32Array) {
      const te = this.elements
      for (let i = 0; i < 16; i++) {
        array[offset + i] = te[i] as number
      }
      return array
    }
    return generic.call(this, array, offset)
  }
  Reflect.set(proto, 'toArray', fast)
  Reflect.set(proto, FLAG, true)
}
