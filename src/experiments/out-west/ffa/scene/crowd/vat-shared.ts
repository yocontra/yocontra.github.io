/** Types and constants shared by the VAT bake worker and the main thread. */
import type { AnimationClipJSON } from 'three'

export const VAT_W = 1024

export interface VatJob {
  json: unknown
  clips: AnimationClipJSON[]
  fps: number
  targetTris: number
  headUuid: string
  /** Linear-RGB marker colours for palette slots 1 and 2. */
  markers: [number, number, number][]
}

export interface VatClipInfo {
  name: string
  start: number
  frames: number
}

export interface VatResult {
  pos: Uint16Array
  nrm: Uint8Array
  color: Float32Array
  /** Atlas UV and recolour luminance per kept vertex (see scene/shade.ts). */
  uv: Float32Array
  lum: Float32Array
  slot: Float32Array
  index: Uint32Array
  rows: number
  vertexCount: number
  clips: VatClipInfo[]
  /** Per frame: head position xyz + quaternion xyzw, in actor-root space. */
  head: Float32Array
  sourceTris: number
}
