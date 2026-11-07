/** Native cuff-to-wrist readback and an explicit diagnostic overlay. */
import { Mesh, MeshBasicMaterial, type Scene, SphereGeometry, Vector3 } from 'three'
import type { Actor } from '../../src/experiments/out-west/scene/actor.ts'

export function measureCuffs(actor: Actor) {
  return actor.meshes.flatMap((mesh) => {
    const markers = mesh.geometry.userData.cuffs as
      | { side: 'L' | 'R'; vertices: number[] }[]
      | undefined
    return (markers ?? []).flatMap((cuff) => {
      const wrist = cuff.side === 'L' ? actor.handL : actor.handR
      if (!wrist) {
        return []
      }
      const center = new Vector3()
      for (const vertex of cuff.vertices) {
        center.add(mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld))
      }
      center.divideScalar(cuff.vertices.length)
      const actual = wrist.getWorldPosition(new Vector3())
      return [
        {
          side: cuff.side,
          gapM: center.distanceTo(actual),
          position: center.toArray(),
          wrist: actual.toArray(),
        },
      ]
    })
  })
}

export function markCuffs(
  actor: Actor,
  stage: { scene: Scene; take: (group: string, name: string) => void },
  name: string,
): void {
  const markers: Mesh[] = []
  const sphere = new SphereGeometry(0.012, 8, 6)
  for (const mesh of actor.meshes) {
    const cuffs = mesh.geometry.userData.cuffs as
      | { side: 'L' | 'R'; vertices: number[] }[]
      | undefined
    for (const cuff of cuffs ?? []) {
      const wrist = cuff.side === 'L' ? actor.handL : actor.handR
      if (!wrist) {
        continue
      }
      const center = new Vector3()
      for (const vertex of cuff.vertices) {
        center.add(mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld))
      }
      center.divideScalar(cuff.vertices.length)
      for (const [point, color] of [
        [center, 0xff_00_ff],
        [wrist.getWorldPosition(new Vector3()), 0x00_ff_00],
      ] as const) {
        const dot = new Mesh(sphere, new MeshBasicMaterial({ color, depthTest: false }))
        dot.renderOrder = 1000
        dot.position.copy(point)
        stage.scene.add(dot)
        markers.push(dot)
      }
    }
  }
  stage.take('tailoring-joints', name)
  for (const marker of markers) {
    marker.removeFromParent()
    ;(marker.material as MeshBasicMaterial).dispose()
  }
  sphere.dispose()
}
