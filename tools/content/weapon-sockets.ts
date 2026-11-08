/** Preserve authored barrel endpoints independently of mesh quantization and leaf pruning. */
import type { Document } from '@gltf-transform/core'
import { Mat4, Quat, Vec3 } from 'playcanvas'

interface SocketFrame {
  mount: string
  translation: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
}
export function captureWeaponSockets(doc: Document): SocketFrame[] {
  return doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getName() === 'socket.muzzle')
    .map((socket) => {
      let mount = socket.getParentNode()
      while (mount && !mount.getName().startsWith('mount.')) {
        mount = mount.getParentNode()
      }
      if (!mount) {
        throw new Error('Authored muzzle has no explicit weapon mount')
      }
      const matrix = new Mat4()
        .set(mount.getWorldMatrix())
        .invert()
        .mul(new Mat4().set(socket.getWorldMatrix()))
      const p = matrix.getTranslation(new Vec3())
      const q = new Quat().setFromMat4(matrix)
      const s = matrix.getScale(new Vec3())
      return {
        mount: mount.getName(),
        translation: [p.x, p.y, p.z],
        rotation: [q.x, q.y, q.z, q.w],
        scale: [s.x, s.y, s.z],
      }
    })
}
export function restoreWeaponSockets(
  doc: Document,
  frames: readonly SocketFrame[],
  id: string,
): void {
  for (const node of [...doc.getRoot().listNodes()]) {
    if (node.getName() === 'socket.muzzle') {
      node.dispose()
    }
  }
  for (const frame of frames) {
    const mount = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === frame.mount)
    if (!mount) {
      throw new Error(`Missing authored ${id} muzzle mount${frame.mount}`)
    }
    const socket = doc
      .createNode('socket.muzzle')
      .setTranslation(frame.translation)
      .setRotation(frame.rotation)
      .setScale(frame.scale)
    socket.setExtras({ role: 'weapon-muzzle' })
    mount.addChild(socket)
  }
}
