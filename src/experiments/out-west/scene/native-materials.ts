/** Shared native PBR textures. Retired outfits and dye previews release their GPU maps. */
import { type ContainerResource, StandardMaterial, type Texture } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import type { DyeId } from '../data/dye.ts'

interface Surface {
  albedo: string
  normal?: string
  arm?: string
  armUv?: number
  /** Explicit: original character ARM.r can be a dye mask instead of occlusion. */
  ao?: boolean
  aoUv?: number
  aoStrength?: number
  roughnessVertexScale?: number
  dyes?: Partial<Record<DyeId, string>>
}
interface NativeContainer {
  gltf?: { materials?: { extras?: { nativePbr?: Surface } }[] }
}
interface TextureLease {
  users: number
  ready: Promise<Texture>
}
interface MaterialsLease {
  users: number
  ready: Promise<void>
  release: () => void
}
const textures = new WeakMap<GameApplication, Map<string, TextureLease>>()
const prepared = new WeakMap<ContainerResource, MaterialsLease>()
const dyes = new WeakMap<StandardMaterial, Surface['dyes']>()
const dyeReleases = new WeakMap<StandardMaterial, () => void>()

function acquire(game: GameApplication, url: string, srgb: boolean): Promise<Texture> {
  let pool = textures.get(game)
  if (!pool) {
    pool = new Map()
    textures.set(game, pool)
  }
  const existing = pool.get(url)
  if (existing) {
    existing.users++
    return existing.ready
  }
  const ready = game
    .loadTexture(url, { srgb, flipY: false })
    .then((asset) => asset.resource as Texture)
  pool.set(url, { users: 1, ready })
  return ready
}
function release(game: GameApplication, url: string): void {
  const pool = textures.get(game)
  const lease = pool?.get(url)
  if (!lease || --lease.users > 0) {
    return
  }
  pool?.delete(url)
  game.releaseTexture(url)
}

function bindOcclusion(
  material: StandardMaterial,
  source: Surface,
  arm: Texture,
  owned: Set<StandardMaterial>,
): void {
  if (!source.ao || material.aoMap) {
    return
  }
  material.aoMap = arm
  material.aoMapChannel = 'r'
  material.aoMapUv = source.aoUv ?? source.armUv ?? 0
  material.aoIntensity = source.aoStrength ?? material.aoIntensity
  owned.add(material)
}

/** Each instantiated model owns one lease; the underlying engine Texture is shared by URL. */
export async function prepareNativeMaterials(
  game: GameApplication,
  resource: ContainerResource,
): Promise<() => void> {
  let lease = prepared.get(resource)
  if (!lease) {
    const urls: string[] = []
    const materials: StandardMaterial[] = []
    const occlusion = new Set<StandardMaterial>()
    const ready = Promise.allSettled(
      resource.materials.map(async (asset, index) => {
        const source = (resource as ContainerResource & { data: NativeContainer }).data.gltf
          ?.materials?.[index]?.extras?.nativePbr
        const material = asset.resource
        if (!(source && material instanceof StandardMaterial)) {
          return
        }
        materials.push(material)
        const load = (url: string, srgb: boolean) => {
          urls.push(url)
          return acquire(game, url, srgb)
        }
        const [albedo, normal, arm] = await Promise.all([
          load(source.albedo, true),
          source.normal ? load(source.normal, false) : null,
          source.arm ? load(source.arm, false) : null,
        ])
        material.diffuseMap = albedo
        if (normal) {
          material.normalMap = normal
          material.bumpiness = 1.4
        }
        if (arm) {
          material.metalnessMap = arm
          material.metalnessMapChannel = 'b'
          material.glossMap = arm
          material.glossMapChannel = 'g'
          material.glossInvert = true
          material.glossMapUv = source.armUv ?? 0
          material.metalnessMapUv = source.armUv ?? 0
          bindOcclusion(material, source, arm, occlusion)
        }
        if (source.roughnessVertexScale) {
          material.glossVertexColor = true
          material.glossVertexColorChannel = 'a'
          material.gloss = source.roughnessVertexScale
        }
        material.diffuseVertexColor = true
        material.update()
        dyes.set(material, source.dyes)
      }),
    ).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        throw failed.reason
      }
    })
    lease = {
      users: 0,
      ready,
      release: () => {
        for (const material of materials) {
          material.diffuseMap = null
          material.normalMap = null
          material.metalnessMap = null
          material.glossMap = null
          if (occlusion.has(material)) {
            material.aoMap = null
          }
          material.update()
        }
        for (const url of urls) {
          release(game, url)
        }
        prepared.delete(resource)
      },
    }
    prepared.set(resource, lease)
  }
  lease.users++
  const active = lease
  let released = false
  const dispose = () => {
    if (!released) {
      released = true
      if (--active.users === 0) {
        active.release()
      }
    }
  }
  try {
    await active.ready
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}

export async function dyedNativeMaterial(
  game: GameApplication,
  original: StandardMaterial,
  dye: DyeId,
): Promise<StandardMaterial | null> {
  const url = dyes.get(original)?.[dye]
  if (!url) {
    return null
  }
  let texture: Texture
  try {
    texture = await acquire(game, url, true)
  } catch (error) {
    release(game, url)
    throw error
  }
  const material = original.clone()
  material.diffuseMap = texture
  material.update()
  dyeReleases.set(material, () => release(game, url))
  return material
}

export function destroyDyedMaterial(material: StandardMaterial): void {
  dyeReleases.get(material)?.()
  dyeReleases.delete(material)
  material.destroy()
}
