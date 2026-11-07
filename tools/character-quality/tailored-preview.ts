/** Plain front/side/back shoulders and every fitted base/outfit, through the real character path. */
import { type Object3D, SkinnedMesh, Vector3 } from 'three'
import { CATALOG, DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { Assets } from '../../src/experiments/out-west/engine/assets.ts'
import { Actor, type Clip } from '../../src/experiments/out-west/scene/actor.ts'
import { castActor } from '../../src/experiments/out-west/scene/cast.ts'
import { loadoutOpts } from '../../src/experiments/out-west/scene/loadout.ts'

export interface CropFrame {
  group: string
  name: string
  y: number
  distance: number
  yaw?: number
}
interface Stage {
  pose: (actor: Actor, group: string, name: string) => void
  crop: (actor: Actor, frame: CropFrame) => void
}

export interface ModelEvidence {
  base: string
  sceneUuid: string
  sourceSkins: { uuid: string; vertices: number }[]
}

export async function captureTailored(
  assets: Assets,
  gun: Object3D,
  stage: Stage,
  closeupsOnly = false,
): Promise<ModelEvidence[]> {
  const models: ModelEvidence[] = []
  for (const base of ['casual', 'worker', 'suit', 'rugged', 'punk', 'king', 'woman'] as const) {
    await assets.body(base)
    const actor = castActor(assets, {
      look: { base, tint: {}, scale: 1 },
      hat: 'cowboy',
      hatColor: 0x3a_2a_1a,
      gun,
    })
    actor.draw()
    for (const [clip, time] of [
      ['Idle', 0],
      ['Walk', 0.2],
      ['Walk', 0.65],
      ['Run', 0.15],
      ['Idle_Gun_Pointing', 0.2],
    ] as [Clip, number][]) {
      actor.play(clip, 0)
      actor.update(time)
      stage.pose(actor, 'bases', `${base}-${clip}-${time}`)
      if (clip === 'Idle') {
        captureCloseups(actor, base, stage)
        stage.crop(actor, {
          group: 'tailoring',
          name: base,
          y: actor.height * 0.71,
          distance: 1.65,
        })
      }
      captureWaist(actor, clip, base, stage)
      if (clip === 'Idle' || clip === 'Idle_Gun_Pointing') {
        for (const [view, yaw] of [
          ['front', 0],
          ['side', Math.PI / 2],
          ['back', Math.PI],
        ] as const) {
          stage.crop(actor, {
            group: 'sewn-shoulders',
            name: `${base}-${clip}-${view}`,
            y: actor.height * 0.71,
            distance: 1.65,
            yaw,
          })
        }
      }
    }
    actor.dispose()
    const model = assets.bodyNow(base)
    if (!model) {
      throw new Error(`Missing actual ${base} outfit base`)
    }
    const sourceSkins: ModelEvidence['sourceSkins'] = []
    model.scene.traverse((node) => {
      if (node instanceof SkinnedMesh) {
        sourceSkins.push({
          uuid: node.uuid,
          vertices: node.geometry.getAttribute('position').count,
        })
      }
    })
    models.push({ base, sceneUuid: model.scene.uuid, sourceSkins })
    for (const item of CATALOG.filter(
      (candidate) => !closeupsOnly && candidate.slot === 'outfit',
    )) {
      const dressed = new Actor(model, {
        ...loadoutOpts({ ...DEFAULT_LOADOUT, outfit: item.id }),
        base,
        clips: assets.player.animations,
        gun,
      })
      dressed.draw()
      dressed.update(0)
      stage.pose(dressed, 'outfit-bases', `${base}-${item.id}`)
      dressed.dispose()
    }
  }
  return models
}

function captureCloseups(actor: Actor, base: string, stage: Stage): void {
  for (const [part, y, distance] of [
    ['face', actor.height * 0.91, 0.85],
    ['shirt', actor.height * 0.72, 1.25],
    ['boots', 0.23, 1.05],
  ] as const) {
    for (const [view, yaw] of [
      ['front', 0],
      ['quarter', 0.6],
    ] as const) {
      stage.crop(actor, {
        group: 'closeups',
        name: `${base}-${part}-${view}`,
        y,
        distance,
        yaw,
      })
    }
  }
}

function captureWaist(actor: Actor, clip: Clip, base: string, stage: Stage): void {
  if (clip === 'Run') {
    const waist = actor.hips?.getWorldPosition(new Vector3()).y ?? actor.height * 0.5
    for (const [view, yaw] of [
      ['front', 0],
      ['side', Math.PI / 2],
      ['back', Math.PI],
    ] as const) {
      stage.crop(actor, {
        group: 'waist-action',
        name: `${base}-${clip}-${view}`,
        y: waist + 0.1,
        distance: 0.9,
        yaw,
      })
    }
  }
}
