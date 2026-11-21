/** Replace the felt mesh and keep the existing native hat mount and dye palette. */
import { Material, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  copyToDocument,
  dedup,
  join,
  prune,
  quantize,
  unpartition,
  weld,
} from '@gltf-transform/functions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

export async function fitBatteredBrim(source: string, target: string): Promise<void> {
  const [authored, outfit] = await Promise.all([io.read(source), io.read(target)])
  const mount = outfit
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'mount.Head.accessory')
  const shell = mount?.listChildren()[0]?.listChildren()[0]?.listChildren()[0]
  const former = shell?.getMesh()
  const felt = former?.listPrimitives()[0]?.getMaterial()
  const scene = authored.getRoot().getDefaultScene()
  if (!(mount && shell && former && felt?.getName() === 'Dyeable' && scene)) {
    throw new Error('Missing the fitted Battered Brim and its native dye material')
  }

  const parts = scene.listChildren()
  if (
    parts.length === 0 ||
    parts.some((part) => !part.getMesh() || part.listChildren().length > 0)
  ) {
    throw new Error('The replacement hat must contain independent authored parts')
  }
  const mapped = copyToDocument(outfit, authored, parts)
  const importedFelt = authored
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === 'Brim felt')
  const sourceFelt = importedFelt && mapped.get(importedFelt)
  if (!(sourceFelt instanceof Material)) {
    throw new Error('Missing the replacement felt material')
  }
  shell
    .setName('Battered Brim')
    .setExtras({})
    .setTranslation([0, 0, 0])
    .setScale([1, 1, 1])
    .setMesh(null)
  former.dispose()
  for (const part of parts) {
    const node = mapped.get(part) as (typeof parts)[number] | undefined
    const mesh = node?.getMesh()
    if (!(node && mesh)) {
      throw new Error(`Missing replacement hat part ${part.getName()}`)
    }
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMaterial() === sourceFelt) {
        const uv = primitive.getAttribute('TEXCOORD_0')
        if (!uv) {
          throw new Error('Missing felt UVs')
        }
        for (let index = 0; index < uv.getCount(); index++) {
          const [u = 0, v = 0] = uv.getElement(index, [])
          // Use the occupied felt strip of the original trimmed dye atlas.
          uv.setElement(index, [0.505 + 0.224 * u, 0.025 + 0.945 * v])
        }
        primitive.setMaterial(felt)
      }
    }
    shell.addChild(node)
  }
  await outfit.transform(
    join({ keepNamed: false, cleanup: false }),
    dedup(),
    weld(),
    quantize({ cleanup: false, quantizePosition: 16 }),
    prune({ keepAttributes: true, keepLeaves: true }),
    unpartition(),
  )
  // The fitted head mount must survive optimization.
  const result = outfit
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === mount.getName())
  if ((result?.listChildren().length ?? 0) === 0) {
    throw new Error('Hat optimizer lost the head mount')
  }
  await io.write(target, outfit)
}
