/**
 * Frontier's extra character clips (`models/moves.glb`, built by `tools/build-moves.ts` from the
 * Universal Animation Library): sprint, crouch idle and walk, the jump's start, loop and landing,
 * the pistol reload, and the pistol aimed up and down. Loaded once, before any rider is cast, and
 * appended to the player's clips, which every base body plays (they share one rig), so every
 * Actor built after this has them as ordinary actions.
 */
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Assets } from '../../engine/assets.ts'

const URL = '/experiments/out-west/3d/models/moves.glb'

/** Append the move clips to the player's (idempotent). Riders cast before it lack them. */
export async function loadMoves(assets: Assets): Promise<void> {
  const have = assets.player.animations
  if (have.some((c) => c.name === 'Sprint')) {
    return
  }
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const g = await loader.loadAsync(URL)
  for (const clip of g.animations) {
    if (!have.some((c) => c.name === clip.name)) {
      have.push(clip)
    }
  }
}
