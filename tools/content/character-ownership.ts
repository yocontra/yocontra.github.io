/** Native skin, PBR-map and owned-batch lifetime regression against real engine resources. */
import { StandardMaterial } from 'playcanvas'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { equippedActor } from '../../src/experiments/out-west/scene/native-equipment.ts'

export function characterTextureSnapshot(game: GameApplication): {
  count: number
  bytes: number
  maps: { url: string; bytes: number; width: number; height: number; format: number }[]
  vram: number
  drawCalls: unknown
} {
  const maps = game.app.assets
    .filter(
      (asset) =>
        asset.type === 'texture' &&
        Boolean(asset.resource) &&
        String((asset.file as { url?: string } | null)?.url).includes('/native-v2/characters/'),
    )
    .map((asset) => ({
      url: (asset.file as { url: string }).url,
      bytes: (asset.resource as import('playcanvas').Texture).gpuSize,
      width: (asset.resource as import('playcanvas').Texture).width,
      height: (asset.resource as import('playcanvas').Texture).height,
      format: (asset.resource as import('playcanvas').Texture).format,
    }))
  return {
    count: maps.length,
    bytes: maps.reduce((sum, map) => sum + map.bytes, 0),
    maps,
    vram: game.app.stats.vram.tex,
    drawCalls: { ...game.app.stats.drawCalls },
  }
}
export async function probeCharacterOwnership(original: GameApplication) {
  const cloth = (rider: DuelActor) => {
    for (const render of rider.model.findComponents('render')) {
      for (const instance of render.meshInstances) {
        if (
          instance.skinInstance &&
          instance.material instanceof StandardMaterial &&
          instance.material.name === 'Dyeable' &&
          instance.material.normalMap
        ) {
          return instance.material
        }
      }
    }
    throw new Error('Missing fitted cloth native material')
  }
  const skins = (rider: DuelActor) =>
    new Set(
      rider.root.findComponents('render').flatMap((render) =>
        render.meshInstances.flatMap((instance) => {
          if (!instance.skinInstance) {
            return []
          }
          if (render.rootBone !== instance.skinInstance.rootBone) {
            throw new Error('Native component and skin cache own different root bones')
          }
          return [instance.skinInstance]
        }),
      ),
    )
  const baselineVram = original.app.stats.vram.tex
  const first = await equippedActor(original, DEFAULT_LOADOUT, {
    [DEFAULT_LOADOUT.outfit]: 'oxblood',
  })
  const second = await equippedActor(original, DEFAULT_LOADOUT, {
    [DEFAULT_LOADOUT.outfit]: 'sage',
  })
  const a = cloth(first)
  const b = cloth(second)
  const firstSkins = skins(first)
  const secondSkins = skins(second)
  if (a.normalMap !== b.normalMap || a.glossMap !== b.glossMap || a.diffuseMap === b.diffuseMap) {
    throw new Error(
      `Native sharing/dye isolation failed: ${JSON.stringify({ a: { normal: a.normalMap?.name, gloss: a.glossMap?.name, color: a.diffuseMap?.name }, b: { normal: b.normalMap?.name, gloss: b.glossMap?.name, color: b.diffuseMap?.name }, sameNormal: a.normalMap === b.normalMap, sameGloss: a.glossMap === b.glossMap, sameColor: a.diffuseMap === b.diffuseMap })}`,
    )
  }
  const two = characterTextureSnapshot(original)
  const normal = b.normalMap
  first.destroy()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (normal?.device !== original.app.graphicsDevice || b.normalMap !== normal) {
    throw new Error('Destroying one rider invalidated another material')
  }
  if ([...firstSkins].some((skin) => skin.boneTexture?.device)) {
    throw new Error('Retired first rider retained a native skin texture')
  }
  second.destroy()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const empty = characterTextureSnapshot(original)
  if (empty.count !== 0) {
    throw new Error(`Retired character maps retained: ${empty.count}`)
  }
  if (
    [...secondSkins].some((skin) => skin.boneTexture?.device) ||
    original.app.stats.vram.tex !== baselineVram
  ) {
    throw new Error('Last rider did not return the live application to its native texture baseline')
  }
  const reopenedActor = await equippedActor(original, DEFAULT_LOADOUT)
  const reopened = cloth(reopenedActor)
  if (!(reopened.diffuseMap && reopened.normalMap) || reopened.normalMap === normal) {
    throw new Error('Retired maps failed to rehydrate')
  }
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const other = await GameApplication.create({ canvas, viewport: document.body, pixelRatio: 1 })
  const otherActor = await equippedActor(other, DEFAULT_LOADOUT)
  skins(otherActor)
  const ownMap = reopened.normalMap
  const otherMap = cloth(otherActor).normalMap
  if (ownMap === otherMap || ownMap.device === otherMap?.device) {
    throw new Error('Two applications shared a GPU Texture')
  }
  const otherDevice = other.app.graphicsDevice
  const batcher = other.app.batcher
  const owned = batcher.getGroupByName('Rider equipment')
  const unrelated = batcher.addGroup('Unrelated regression group', false, 24)
  if (!owned) {
    throw new Error('Missing owned native gear group')
  }
  otherActor.destroy()
  other.stage.destroy()
  if (batcher.getGroupById(owned.id) || !batcher.getGroupById(unrelated.id)) {
    throw new Error('Gear teardown failed to retire only its owned batch group')
  }
  other.destroy()
  canvas.remove()
  if (otherDevice.textures.size > 0) {
    throw new Error('Disposed application retained native GPU textures')
  }
  if (ownMap.device !== original.app.graphicsDevice) {
    throw new Error('Destroying the second application invalidated the first')
  }
  return {
    actor: reopenedActor,
    proof: {
      two,
      empty,
      reopened: characterTextureSnapshot(original),
      separateDevices: true,
      nativeTextureBaselineRestored: true,
      ownedGroupRetired: true,
      unrelatedGroupPreserved: true,
      disposedNativeTextures: otherDevice.textures.size,
    },
  }
}
