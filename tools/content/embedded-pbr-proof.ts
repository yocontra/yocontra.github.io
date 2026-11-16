/** Read-only native shader cache evidence for the environment BRDF comparison. */
import type { MeshInstance, RenderComponent, StandardMaterial } from 'playcanvas'
import type { GameApplication as GameApp } from '../../src/experiments/out-west/client/application.ts'
import type { NativeEnvironment as Environment } from '../../src/experiments/out-west/client/environment.ts'
import type { NativeArenas as Arenas } from '../../src/experiments/out-west/duel/native-arenas.ts'

type Point = [number, number, number]
export interface SceneReview {
  game: GameApp
  arenas?: Arenas
  environment: Environment
  sources: Set<StandardMaterial>
  clones: StandardMaterial[]
  materials: Set<StandardMaterial>
  cameras: Record<string, { position: Point; target: Point; fov?: number }>
  identity?: (value: object) => number
}

export function installShaderInspection() {
  const shaderHashes = new Map<number, string>()
  Reflect.set(globalThis, '__embeddedInspectShaders', async (ggx: boolean) => {
    const {
      game,
      materials,
      identity: identify,
    } = Reflect.get(globalThis, '__embeddedScene') as SceneReview
    if (!identify) {
      throw new Error('Missing identity registry')
    }
    const renders = () => game.app.root.findComponents('render') as RenderComponent[]
    const batchList = Reflect.get(game.app.batcher, '_batchList') as {
      meshInstance: MeshInstance | null
    }[]
    const visible = [
      ...new Set([
        ...renders().flatMap((render) => render.meshInstances),
        ...batchList.flatMap((batch) => (batch.meshInstance ? [batch.meshInstance] : [])),
      ]),
    ].filter(
      (instance) =>
        instance.visibleThisFrame && materials.has(instance.material as StandardMaterial),
    )
    const shaders: {
      id: number
      material: number
      branch: string
      fragmentSHA256: string | undefined
    }[] = []
    const cached = visible.flatMap((instance) => {
      const cache = Reflect.get(instance, '_shaderCache') as Map<
        number,
        { shader: { id: number; definition: { fshader?: string } } }
      >
      return [...cache.values()].map(({ shader }) => ({
        shader,
        material: identify(instance.material as StandardMaterial),
      }))
    })
    for (const { shader, material } of cached) {
      const fragment = shader.definition.fshader ?? ''
      const native = fragment.includes('float D = alpha /')
      const control = fragment.includes('float specPow = exp2(')
      if (!(native || control)) {
        continue // Shadow, depth and other non-specular passes.
      }
      if (native !== ggx || control === ggx) {
        throw new Error('Active native shader cache has the wrong BRDF')
      }
      if (!shaderHashes.has(shader.id)) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fragment))
        shaderHashes.set(
          shader.id,
          Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
            '',
          ),
        )
      }
      shaders.push({
        id: shader.id,
        material,
        branch: native ? 'GGX' : 'Blinn',
        fragmentSHA256: shaderHashes.get(shader.id),
      })
    }
    if (shaders.length === 0) {
      throw new Error('No visible native forward shader BRDF was observed')
    }
    Reflect.set(globalThis, '__embeddedPbrShaders', shaders)
  })
}
