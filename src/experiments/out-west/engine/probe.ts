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
  BackSide,
  Color,
  CubeCamera,
  HalfFloatType,
  type HemisphereLight,
  Mesh,
  type Object3D,
  type PerspectiveCamera,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
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
  /** True: capture the real street. False: a cheap gradient in the street's own colours. */
  private readonly town: boolean
  private readonly target = new WebGLCubeRenderTarget(SIZE, { type: HalfFloatType })
  private readonly cube: CubeCamera
  private readonly pmrem: PMREMGenerator
  private env: WebGLRenderTarget | null = null
  private envScene: Scene | null = null
  private envMat: ShaderMaterial | null = null
  private hemi: HemisphereLight | null = null
  private version = -1
  /** Next face to capture; 6 means idle. */
  private face = 6
  readonly position = new Vector3(0, 1.7, 0)
  /**
   * Environment intensity applied through scene.environmentIntensity. A little over 1: the probe
   * carries most of the fill (the hemisphere light is only a small lift, see presets.ts), and the
   * capture misses the characters and particles that would bounce some light back.
   */
  intensity = 1.2

  constructor(gl: WebGLRenderer, scene: Scene, town = true) {
    this.gl = gl
    this.scene = scene
    this.town = town
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
    if (!this.town) {
      this.gradient()
      return
    }
    for (let f = 0; f < 6; f++) {
      this.captureFace(f)
    }
    this.finish()
  }

  /** Call once per frame. Returns true while a capture is in flight. */
  tick(): boolean {
    const v = (this.scene.userData.owLightVersion as number | undefined) ?? 0
    if (!this.town) {
      // A gradient is a fraction of a capture: rebuild it when the light moves, in this frame.
      if (v !== this.version) {
        this.version = v
        this.gradient()
      }
      return false
    }
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

  /**
   * The phone fallback: a sky/ground gradient in the current hemisphere light's colours, run
   * through the same PMREM. It gives standard materials their fill and their metal something to
   * reflect without compiling a linear variant of every town material (which is what capturing
   * the street costs).
   */
  private gradient(): void {
    if (!this.hemi) {
      this.scene.traverse((o) => {
        if (!this.hemi && (o as HemisphereLight).isHemisphereLight) {
          this.hemi = o as HemisphereLight
        }
      })
    }
    const sky = this.hemi?.color ?? new Color(0xb8_d0_ff)
    const ground = this.hemi?.groundColor ?? new Color(0xb8_86_52)
    if (!(this.envScene && this.envMat)) {
      this.envScene = new Scene()
      this.envMat = new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        uniforms: {
          sky: { value: new Color() },
          horizon: { value: new Color() },
          ground: { value: new Color() },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 sky;
          uniform vec3 horizon;
          uniform vec3 ground;
          varying vec3 vDir;
          void main() {
            float h = normalize(vDir).y;
            vec3 c = h >= 0.0
              ? mix(horizon, sky, pow(h, 0.55))
              : mix(horizon, ground, pow(-h, 0.45));
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      })
      this.envScene.add(new Mesh(new SphereGeometry(10, 16, 8), this.envMat))
    }
    const u = this.envMat.uniforms
    const set = (name: 'sky' | 'ground' | 'horizon', color: Color): void => {
      const uniform = u[name]
      if (uniform) {
        ;(uniform.value as Color).copy(color)
      }
    }
    set('sky', sky)
    set('ground', ground)
    set('horizon', sky.clone().lerp(ground, 0.5))
    const next = this.pmrem.fromScene(this.envScene, 0.04, 0.1, 100)
    this.env?.dispose()
    this.env = next
    this.scene.environment = next.texture
    this.scene.environmentIntensity = this.intensity
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
