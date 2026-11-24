/** Install the Blender reference sculpt onto fitted, quantized skin in its existing bind space. */
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NodeIO, type vec3 } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { compressedCharacterTexture } from './character-textures.ts'
import { contentOutput } from './content-output.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const art = resolve('tools/art/characters/saloon-cast')
interface Sculpt {
  vertices: number
  anchors: [number, number]
  depths: [number, number]
  uvChecks: [number, number, number][]
  edits: [number, number, number, number, number][]
}

export async function installSaloonCast(id: string): Promise<void> {
  if (!(id === 'player' || id === 'outlaw-0' || id.startsWith('outfit.'))) {
    return
  }
  const actor = id === 'outlaw-0' ? 'greenhorn' : 'rider'
  const path = contentOutput(id.startsWith('outfit.') ? 'equipment' : 'baked', `${id}.glb`)
  const native = await io.read(path)
  const faces = native
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .filter((part) => part.getMaterial()?.getName() === 'Field-worn skin')
  const face = faces[0]
  const position = face?.getAttribute('POSITION')
  const normal = face?.getAttribute('NORMAL')
  const uv = face?.getAttribute('TEXCOORD_0')
  const material = face?.getMaterial()
  const sculpt = JSON.parse(await readFile(resolve(art, `${actor}-sculpt.json`), 'utf8')) as Sculpt
  if (
    faces.length !== 1 ||
    !position ||
    !normal ||
    !uv ||
    !material ||
    position.getCount() !== sculpt.vertices
  ) {
    throw new Error(`Reference sculpt does not match ${id}`)
  }
  for (const [index, u, v] of sculpt.uvChecks) {
    const mapped = uv.getElement<[number, number]>(index, [0, 0])
    if (Math.abs(mapped[0] - u) > 0.000_02 || Math.abs(mapped[1] - v) > 0.000_02) {
      throw new Error(`Reference face UV order changed for ${id}`)
    }
  }
  // Each fit has its own uniformly scaled bind transform. These two untouched vertices locate it.
  const [near, far] = sculpt.anchors.map((i) => position.getElement<vec3>(i, [0, 0, 0])[2])
  if (near === undefined || far === undefined || far <= near) {
    throw new Error(`Invalid reference head bind for ${id}`)
  }
  const scale = (far - near) / (sculpt.depths[1] - sculpt.depths[0])
  for (const [index, depth, nx, ny, nz] of sculpt.edits) {
    const xyz = position.getElement<vec3>(index, [0, 0, 0])
    xyz[2] = near + scale * (depth - sculpt.depths[0])
    position.setElement(index, xyz)
    normal.setElement(index, [nx, ny, nz])
  }
  const maps = material.getExtras().nativePbr
  if (!(maps && typeof maps === 'object' && 'normal' in maps)) {
    throw new Error(`Missing native skin maps for ${id}`)
  }
  const albedo = await compressedCharacterTexture(
    await readFile(resolve(art, `${actor}-color.png`)),
    true,
  )
  const arm = await compressedCharacterTexture(
    await readFile(resolve(art, `${actor}-arm.png`)),
    false,
  )
  material.setExtras({
    ...material.getExtras(),
    nativePbr: { ...maps, albedo, arm, width: 1536, height: 1536, surface: 'skin' },
  })
  const hands = native
    .getRoot()
    .listMaterials()
    .find((m) => m.getName() === 'field-hands')
  if (hands) {
    const skin = hands.getExtras().nativePbr
    if (!(skin && typeof skin === 'object' && 'normal' in skin)) {
      throw new Error(`Missing fitted hand maps for ${id}`)
    }
    const handColor = await compressedCharacterTexture(
      await readFile(resolve(art, 'hands-color.png')),
      true,
    )
    hands.setExtras({ ...hands.getExtras(), nativePbr: { ...skin, albedo: handColor } })
  }
  await io.write(path, native)
}

if (import.meta.main) {
  const outfits = (await readdir(resolve(art, '..')))
    .filter((file) => file.startsWith('outfit.') && file.endsWith('.gltf'))
    .map((file) => file.slice(0, -5))
  for (const id of ['player', 'outlaw-0', ...outfits]) {
    await installSaloonCast(id)
  }
}
