/** Apply offline paired hand seats to rigid gun geometry and muzzle sockets together. */
import type { Document, mat4 } from '@gltf-transform/core'
import { Mat4 } from 'playcanvas'

type Rows = number[][]
interface Seat {
  old: Rows
  new: Rows
}
function matrix(rows: Rows): Mat4 {
  if (rows.length !== 4 || rows.some((row) => row.length !== 4 || !row.every(Number.isFinite))) {
    throw new Error('Paired gun frame must contain a finite 4 by 4 matrix')
  }
  return new Mat4().set(Array.from({ length: 16 }, (_, i) => rows[i % 4]?.[Math.floor(i / 4)] ?? 0))
}

/** Mesh decoding transforms remain intact; the same correction also moves each explicit socket. */
export function applyPairedGripSeats(doc: Document, authored: Document): void {
  if (doc.getRoot().getExtras().pairedGripSeats) {
    throw new Error('Paired gun seats are already applied')
  }
  const frames = authored.getRoot().getExtras().gunFrames as Record<string, Seat> | undefined
  const mounts = ['L', 'R'].map((side) => {
    const seat = frames?.[side]
    const mount = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === `mount.Wrist${side}.drawn`)
    if (!(seat && mount?.listChildren().some((n) => n.getMesh()))) {
      throw new Error(`Missing authored paired ${side} gun seat`)
    }
    if (!mount.listChildren().some((n) => n.getName() === 'socket.muzzle')) {
      throw new Error(`Missing paired ${side} muzzle socket`)
    }
    return { mount, correction: matrix(seat.new).mul(matrix(seat.old).invert()) }
  })
  for (const { mount, correction } of mounts) {
    for (const child of mount.listChildren()) {
      child.setMatrix(
        Array.from(new Mat4().copy(correction).mul(new Mat4().set(child.getMatrix())).data) as mat4,
      )
    }
  }
  doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), pairedGripSeats: true })
}
