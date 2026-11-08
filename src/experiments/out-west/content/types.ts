/** Build-time content contract, independent of either graphics or physics engine. */
export type Vec3 = readonly [number, number, number]
export interface CollisionData {
  version: string
  boxes: readonly { id: string; center: Vec3; halfExtents: Vec3; rotation?: Vec3 }[]
  meshes: readonly { id: string; positions: readonly number[]; indices: readonly number[] }[]
}
export interface ContentAsset {
  url: string
  hash: string
  bytes: number
}
