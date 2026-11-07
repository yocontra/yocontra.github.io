/** Initial garment fitting; prepared living forks reuse its exact immutable result. */
import { type AnimationClip, type Bone, type Object3D, SkinnedMesh } from 'three'
import type { Actor } from './actor.ts'
import type { ActorOpts } from './actor-options.ts'
import { bake, bodyPieces, type Piece } from './bake.ts'
import { type Body, sampleBody } from './fit.ts'
import { fitHat, tuckHair } from './hats.ts'
import type { Fit } from './outfit.ts'
import { measure } from './outfit.ts'
import { paintSkin } from './person.ts'
import { dressPieces, measureStride } from './rig.ts'
import { SLOT } from './roles.ts'
import type { characterMaterial } from './shade.ts'

interface Dressing {
  neutralFrames: NonNullable<Body['neutralFrames']>
  bones: Map<string, Bone>
  realBeard: boolean
  armWith: (fit: Fit, clothes: readonly Piece[], gun: Object3D) => Piece[]
  material: ReturnType<typeof characterMaterial>
}
export function dressActor(model: Object3D, root: Object3D, opts: ActorOpts, fitted: Dressing) {
  const body = { ...sampleBody(model, root), neutralFrames: fitted.neutralFrames }
  const fit = measure(body, fitted.bones)
  const clothes = dressPieces(fit, opts, root, fitted.realBeard)
  const pieces = [
    ...bodyPieces(model, root, body, opts.base === 'woman' ? 'fitted' : 'straight'),
    ...clothes,
  ]
  paintSkin(
    pieces,
    body,
    fit.head,
    opts.paletteSlots?.[SLOT.Skin] ? { ...opts, skin: 'tan' } : opts,
  )
  const hatFit = opts.hat ? fitHat(body, fit.head.eye, opts.hat) : null
  if (hatFit) {
    tuckHair(pieces, hatFit)
  }
  if (opts.gun) {
    pieces.push(
      ...fitted.armWith(
        fit,
        clothes.filter((c) => !c.unbelted),
        opts.gun,
      ),
    )
  }
  const drop: Object3D[] = []
  model.traverse((node) => {
    if (node instanceof SkinnedMesh) {
      drop.push(node)
    }
  })
  for (const node of drop) {
    node.removeFromParent()
  }
  return { body, hatFit, mesh: bake(pieces, body, root, fitted.material) }
}

export function measureActorWalk(
  actor: Actor,
  clip: AnimationClip,
  bones: ReadonlyMap<string, Bone>,
): void {
  const left = bones.get('FootL')
  const right = bones.get('FootR')
  if (!(left && right)) {
    return
  }
  const stride = measureStride({ mixer: actor.mixer, root: actor.root, feet: [left, right] }, clip)
  actor.paceLength = stride.paceLength ?? actor.paceLength
  actor.heelStrikes = stride.heelStrikes
}
