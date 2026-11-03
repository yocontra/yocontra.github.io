/**
 * Town light probe: the stand-in for a Blender-baked probe grid while the
 * Blender pipeline is unavailable (design doc §9.5 items 3–4, §10.4 fallback).
 *
 * A 128² cube capture of the lit street, taken from the duel spot, one face
 * per frame so it never hitches, then prefiltered with PMREM into
 * `scene.environment`. Every standard material gets one bounce of the real
 * street (warm dirt from below, the facades either side, the sky above) for
 * diffuse and for specular on metal and leather, so characters sit *in* the
 * town's light instead of under a flat hemisphere.
 *
 * World bumps `scene.userData.owLightVersion` whenever the time of day moves
 * far enough to matter; the renderer calls `tick()` every frame.
 */
import {
  CubeCamera,
  HalfFloatType,
  type Object3D,
  type PerspectiveCamera,
  PMREMGenerator,
  type Scene,
  type Texture,
  Vector3,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'

const SIZE = 128

/** Objects the capture skips: characters, particles, sprites and anything flagged. */
function skip(o: Object3D): boolean {
  const any = o as Object3D & {
    isSkinnedMesh?: boolean
    isPoints?: boolean
    isSprite?: boolean
  }
  return Boolean(any.isSkinnedMesh || any.isPoints || any.isSprite || o.userData.noProbe)
}

export class TownProbe {
  private readonly gl: WebGLRenderer
  private readonly scene: Scene
  private readonly target = new WebGLCubeRenderTarget(SIZE, { type: HalfFloatType })
  private readonly cube: CubeCamera
  private readonly pmrem: PMREMGenerator
  private env: WebGLRenderTarget | null = null
  private version = -1
  /** Next face to capture; 6 means idle. */
  private face = 6
  readonly position = new Vector3(0, 1.7, 0)
  /** Environment intensity applied through scene.environmentIntensity. */
  intensity = 1

  constructor(gl: WebGLRenderer, scene: Scene) {
    this.gl = gl
    this.scene = scene
    this.cube = new CubeCamera(0.5, 1200, this.target)
    this.cube.coordinateSystem = gl.coordinateSystem
    this.cube.updateCoordinateSystem()
    this.pmrem = new PMREMGenerator(gl)
  }

  get texture(): Texture | null {
    return this.env?.texture ?? null
  }

  /** Capture now, all faces at once (used at load, behind the title). */
  captureNow(): void {
    this.version = (this.scene.userData.owLightVersion as number | undefined) ?? 0
    for (let f = 0; f < 6; f++) {
      this.captureFace(f)
    }
    this.finish()
  }

  /** Call once per frame. Returns true while a capture is in flight. */
  tick(): boolean {
    const v = (this.scene.userData.owLightVersion as number | undefined) ?? 0
    if (this.face === 6 && v !== this.version) {
      this.version = v
      this.face = 0
    }
    if (this.face < 6) {
      // two faces per frame: the capture lands in 3 frames
      this.captureFace(this.face++)
      if (this.face < 6) {
        this.captureFace(this.face++)
      }
      if (this.face === 6) {
        this.finish()
      }
      return true
    }
    return false
  }

  private captureFace(face: number): void {
    const gl = this.gl
    const scene = this.scene
    const hidden: Object3D[] = []
    scene.traverse((o) => {
      if (o.visible && skip(o)) {
        o.visible = false
        hidden.push(o)
      }
    })
    const prevEnv = scene.environment
    // single bounce: never capture the previous capture
    scene.environment = null
    const prevTarget = gl.getRenderTarget()
    const prevAuto = gl.shadowMap.autoUpdate
    gl.shadowMap.autoUpdate = face === 0
    this.cube.position.copy(this.position)
    this.cube.updateMatrixWorld(true)
    const cams = this.cube.children as PerspectiveCamera[]
    const cam = cams[face]
    if (cam) {
      gl.setRenderTarget(this.target, face)
      gl.render(scene, cam)
    }
    gl.setRenderTarget(prevTarget)
    gl.shadowMap.autoUpdate = prevAuto
    scene.environment = prevEnv
    for (const o of hidden) {
      o.visible = true
    }
  }

  private finish(): void {
    const next = this.pmrem.fromCubemap(this.target.texture)
    this.env?.dispose()
    this.env = next
    this.scene.environment = next.texture
    this.scene.environmentIntensity = this.intensity
  }

  dispose(): void {
    this.target.dispose()
    this.env?.dispose()
    this.pmrem.dispose()
  }
}
