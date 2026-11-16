import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Vec3 } from 'playcanvas'
import { applyPairedGripSeats } from '../../tools/content/paired-grip-seats.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const root = 'public/experiments/out-west/3d/native-v2'
const DRAWN = /^mount\.Wrist[LR]\.drawn$/u
for (const asset of ['equipment/gun.hardins-pair', 'baked/outlaw-5', 'baked/outlaw-16']) {
  it(`${asset} moves actual decoded gun meshes and sockets together without changing skin, clips or holsters`, async () => {
    const doc = await io.read(`${root}/${asset}.glb`)
    const authored = await io.read('tools/art/characters/paired-grips/body.glb')
    const frames = authored.getRoot().getExtras().gunFrames as Record<
      string,
      { old: number[][]; new: number[][] }
    >
    const matrix = (rows: number[][]) =>
      new Mat4().set(Array.from({ length: 16 }, (_, i) => rows[i % 4]?.[Math.floor(i / 4)] ?? 0))
    const nodes = doc.getRoot().listNodes()
    const original = new Map(nodes.map((n) => [n, Array.from(n.getMatrix())]))
    const buffers = doc
      .getRoot()
      .listAccessors()
      .map((a) => Array.from(a.getArray() ?? []))
    const changed = new Set(
      nodes.filter((n) => DRAWN.test(n.getName())).flatMap((n) => n.listChildren()),
    )
    const relativeSockets = ['L', 'R'].map((side) => {
      const mount = nodes.find((n) => n.getName() === `mount.Wrist${side}.drawn`)
      const mesh = mount?.listChildren().find((n) => n.getMesh())
      const socket = mount?.listChildren().find((n) => n.getName() === 'socket.muzzle')
      if (!(mesh && socket)) {
        throw new Error('Missing actual paired geometry')
      }
      return {
        side,
        mesh,
        socket,
        before: new Mat4().set(mesh.getMatrix()).invert().mul(new Mat4().set(socket.getMatrix())),
      }
    })
    applyPairedGripSeats(doc, authored)
    let maximum = 0
    for (const { side, mesh, socket, before } of relativeSockets) {
      const seat = frames[side]
      if (!seat) {
        throw new Error('Missing seat fixture')
      }
      const correction = matrix(seat.new).mul(matrix(seat.old).invert())
      for (const node of [mesh, socket]) {
        const prior = original.get(node)
        if (!prior) {
          throw new Error('Original geometry missing')
        }
        const expected = correction.clone().mul(new Mat4().set(prior))
        const actual = new Mat4().set(node.getMatrix())
        for (const point of [new Vec3(0, 0, 0), new Vec3(0.3, 0.1, 0)]) {
          maximum = Math.max(
            maximum,
            expected.transformPoint(point).distance(actual.transformPoint(point)),
          )
        }
      }
      const after = new Mat4()
        .set(mesh.getMatrix())
        .invert()
        .mul(new Mat4().set(socket.getMatrix()))
      for (const point of [new Vec3(0, 0, 0), new Vec3(0.3, 0.1, 0)]) {
        maximum = Math.max(
          maximum,
          before.transformPoint(point).distance(after.transformPoint(point)),
        )
      }
    }
    expect(maximum).toBeLessThan(0.000_002)
    for (const node of nodes.filter((n) => !changed.has(n))) {
      expect(Array.from(node.getMatrix())).toEqual(original.get(node) ?? [])
    }
    expect(
      doc
        .getRoot()
        .listAccessors()
        .map((a) => Array.from(a.getArray() ?? [])),
    ).toEqual(buffers)
    expect(() => applyPairedGripSeats(doc, authored)).toThrow('already applied')
  })
}
