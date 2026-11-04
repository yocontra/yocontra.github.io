// biome-ignore-all lint/complexity/useMaxParams: geometry/audio builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import {
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  type InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PointLight,
  type Scene,
  type Texture,
  Vector3,
  Vector4,
} from 'three'
import { ATMOS, bindAtmos, tickAtmos, withCloudShadow } from './atmos.ts'
import { ClockTower } from './clocktower.ts'
import { buildDesert, desertGeometry } from './desert.ts'
import { GeoBuilder } from './geo.ts'
import { addStatic, buildMesas, buildPosterPost, buildWaterTower } from './landmarks.ts'
import { type Preset, presetAt } from './presets.ts'
import { mergePlaced } from './props.ts'
import { releaseAfterUpload } from './release.ts'
import { Sky } from './sky.ts'
import {
  AWNING,
  BUILDINGS,
  DECK,
  dressBoardwalks,
  facade,
  LANTERNS,
  type Placed,
  SIGNS,
  STREET,
} from './street.ts'
import { RIM } from './style.ts'
import { glassLook } from './surface.ts'
import { signAtlas } from './textures.ts'
import { attachArm, attachBoard, withTownAO } from './town-pbr.ts'

export interface Lantern {
  light: PointLight
  base: number
  phase: number
}

export class World {
  readonly root = new Group()
  readonly sun: DirectionalLight
  readonly hemi: HemisphereLight
  readonly fog: Fog
  readonly sky: Mesh
  private readonly skyDome: Sky
  /** Warm pools of lamp and window light on the street (x, z, radius, ±strength). */
  private readonly poolU = {
    owPools: { value: [] as Vector4[] },
    owLantern: { value: 0 },
    owWindow: { value: 0 },
  }
  readonly ground: Mesh
  readonly lanterns: Lantern[] = []
  readonly flashLight: PointLight
  readonly windowMat: MeshStandardMaterial
  readonly wallMat: MeshStandardMaterial
  readonly trimMat: MeshStandardMaterial
  readonly signMat: MeshStandardMaterial
  /** The courthouse clock tower at the end of the street (built with the town). */
  private tower: ClockTower | null = null
  readonly glintAnchor = new Group()
  readonly poster: Group
  posterMat: MeshStandardMaterial
  preset: Preset
  day = 0
  /** Things to hide on the red silhouette frame. */
  readonly silhouetteHide: Object3D[] = []
  readonly instanced: InstancedMesh[] = []
  readonly saloonDoors: Mesh[] = []
  private time = 0
  private readonly scene: Scene
  /** Day at the last light-probe capture request. */
  private probeDay = -1
  readonly bellPos = new Vector3(0, 13, STREET.churchZ - 6)

  constructor(
    scene: Scene,
    tex: {
      ground: Texture
      groundN: Texture
      planks: Texture
      planksN: Texture
      vplanks: Texture
      vplanksN: Texture
    },
    shadowSize: number,
    tier = 'high',
  ) {
    this.scene = scene
    scene.add(this.root)
    this.preset = presetAt(0)
    this.fog = new Fog(0xe8_d3_a8, 60, 220)
    scene.fog = this.fog

    // --- lights
    this.hemi = new HemisphereLight(0xcf_e0_ff, 0xb0_8a_5a, 1)
    this.root.add(this.hemi)
    this.sun = new DirectionalLight(0xff_f1_d6, 3.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowSize, shadowSize)
    const sc = this.sun.shadow.camera
    sc.left = -20
    sc.right = 20
    sc.top = 20
    sc.bottom = -20
    sc.near = 1
    sc.far = 120
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    this.root.add(this.sun)
    this.root.add(this.sun.target)

    // Lantern lights on the porches nearest the duel (no shadows: one shadow caster only).
    // each light at its lantern's flame (dressing.ts hangs the lanterns from the same table)
    for (const [x, z] of LANTERNS) {
      const l = new PointLight(0xff_a8_50, 0, 16, 1.6)
      l.position.set(x, AWNING - 0.26, z)
      this.root.add(l)
      this.lanterns.push({ light: l, base: 20, phase: Math.random() * 10 })
    }
    this.flashLight = new PointLight(0xff_d0_90, 0, 14, 1.5)
    this.root.add(this.flashLight)

    // --- sky
    this.skyDome = new Sky(this.root, tier === 'high' || tier === 'medium' ? 1 : 0)
    this.sky = this.skyDome.mesh
    this.silhouetteHide.push(this.sky)
    this.poolU.owPools.value = streetPools()

    // --- materials
    this.wallMat = new MeshStandardMaterial({
      map: tex.planks,
      normalMap: tex.planksN,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      color: new Color(1.7, 1.6, 1.5),
    })
    this.trimMat = new MeshStandardMaterial({
      map: tex.vplanks,
      normalMap: tex.vplanksN,
      vertexColors: true,
      roughness: 0.95,
      color: new Color(1.5, 1.45, 1.4),
    })
    this.windowMat = new MeshStandardMaterial({
      color: 0x1a_16_12,
      roughness: 0.25,
      metalness: 0.2,
      emissive: new Color(0xff_9a_40),
      emissiveIntensity: 0,
    })
    glassLook(this.windowMat)
    const atlas = signAtlas(SIGNS)
    this.signMat = new MeshStandardMaterial({ map: atlas.tex, roughness: 0.85 })
    attachBoard(this.signMat, atlas.rows)

    // --- ground
    const groundMat = new MeshStandardMaterial({
      map: tex.ground,
      normalMap: tex.groundN,
      roughness: 1,
      color: 0xd8_c0_a0,
    })
    const pools = this.poolU
    groundMat.onBeforeCompile = (shader) => {
      bindAtmos(shader)
      Object.assign(shader.uniforms, pools)
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWorldP;\nvarying float vSlope;',
        )
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSlope = 1.0 - objectNormal.y;',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldP;
varying float vSlope;
uniform vec4 owPools[${POOLS}];
uniform float owLantern;
uniform float owWindow;
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gn(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(gh(i),gh(i+vec2(1,0)),f.x), mix(gh(i+vec2(0,1)),gh(i+vec2(1,1)),f.x), f.y); }
// a hoofprint field: small dark crescents scattered along the middle of the street
float hoof(vec2 p) {
  vec2 c = floor(p * vec2(2.2, 1.4));
  vec2 f = fract(p * vec2(2.2, 1.4)) - 0.5 + (vec2(gh(c), gh(c + 9.1)) - 0.5) * 0.5;
  float on = step(0.72, gh(c + 3.3));
  float r = length(f * vec2(1.0, 1.25));
  return on * (1.0 - smoothstep(0.12, 0.17, r)) * smoothstep(0.03, 0.1, r);
}`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
{
  vec2 p = vWorldP.xz;
  float ax = abs(p.x);
  float macro = gn(p * 0.04) * 0.6 + gn(p * 0.13) * 0.4;
  diffuseColor.rgb *= mix(0.8, 1.1, macro);
  float inStreet = step(p.y, 58.0) * step(-70.0, p.y);
  // twin wagon ruts down the street and on along the road out of the open end
  float rx = ax;
  float road = step(p.y, -58.0);
  rx = mix(rx, abs(p.x + sin(p.y * 0.02) * 4.0), road);
  float rut = exp(-pow((rx - 1.25) * 5.0, 2.0)) * (0.6 + 0.4 * gn(p * vec2(2.0, 0.3)));
  diffuseColor.rgb *= 1.0 - rut * 0.24 * step(p.y, 58.0) * (1.0 - smoothstep(-200.0, -120.0, -p.y) * road);
  diffuseColor.rgb *= 1.0 - hoof(p) * 0.28 * (1.0 - smoothstep(2.5, 4.5, rx)) * step(p.y, 58.0);
  float street = 1.0 - smoothstep(8.5, 11.0, ax);
  diffuseColor.rgb *= mix(1.04, 0.96, street * inStreet);
  // pale wind-blown sand drifting against the boardwalks and out on the flats
  float drift = smoothstep(0.55, 0.85, gn(vec2(p.x * 0.09 + p.y * 0.05, p.y * 0.02 - p.x * 0.03)));
  drift = max(drift * (1.0 - street * 0.7), smoothstep(7.6, 8.9, ax) * street * inStreet * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.48, 0.33), drift * 0.35);
  // patchy dry grass and scrub soil off the street
  float off = smoothstep(11.0, 26.0, ax) + (1.0 - inStreet);
  float grass = smoothstep(0.5, 0.75, gn(p * 0.21 + 4.0)) * smoothstep(0.35, 0.7, gn(p * 1.3)) * clamp(off, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.36, 0.17), grass * 0.5);
  // the hills: weathered, redder slopes
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 0.86, 0.74), smoothstep(0.08, 0.35, vSlope));
}`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
{
  // warm, flickering pools under the lanterns and below lit windows
  vec3 pool = vec3(0.0);
  for (int i = 0; i < ${POOLS}; i++) {
    vec4 q = owPools[i];
    vec2 d = vWorldP.xz - q.xy;
    float f = exp(-dot(d, d) / (q.z * q.z));
    float fl = 0.86 + 0.09 * sin(atmTime * 9.0 + float(i) * 1.7) + 0.05 * sin(atmTime * 23.0 + float(i) * 3.1);
    float k = q.w > 0.0 ? q.w * owLantern * fl : -q.w * owWindow;
    pool += f * k * (q.w > 0.0 ? vec3(1.0, 0.55, 0.22) : vec3(1.0, 0.62, 0.3));
  }
  reflectedLight.directDiffuse += diffuseColor.rgb * pool;
}`,
        )
    }
    tex.ground.repeat.set(1, 1)
    // real PBR (Poly Haven ARM) and the indirect-only town AO on every street surface
    withTownAO(groundMat, 'ground')
    withTownAO(this.wallMat, 'wall')
    withTownAO(this.trimMat, 'trim')
    attachArm(groundMat, 'ground', 0.8)
    attachArm(this.wallMat, 'planks', 1)
    attachArm(this.trimMat, 'vplanks', 1)
    withCloudShadow(groundMat)
    withCloudShadow(this.wallMat)
    withCloudShadow(this.trimMat)
    const groundGeo = desertGeometry()
    releaseAfterUpload(groundGeo)
    this.ground = new Mesh(groundGeo, groundMat)
    this.ground.name = 'ground'
    this.ground.receiveShadow = true
    this.ground.matrixAutoUpdate = false
    this.ground.updateMatrix()
    this.root.add(this.ground)
    this.silhouetteHide.push(this.ground)

    this.buildTown(atlas.rows)
    buildWaterTower(this.root, this.trimMat)
    buildMesas(this.root, tex.ground)
    this.root.add(buildDesert(tier))
    this.poster = buildPosterPost(this.root, this.trimMat)
    this.posterMat =
      (this.poster.userData.mat as MeshStandardMaterial) ?? new MeshStandardMaterial()

    this.apply(0)
  }

  private buildTown(signRows: number): void {
    const walls = new GeoBuilder(1.9)
    const trim = new GeoBuilder(1.6)
    const glass = new GeoBuilder(1)
    const signs = new GeoBuilder(1)
    const kit: Placed[] = []
    const H = STREET.half
    const Bw = STREET.boardwalk
    const white = new Color(0xff_ff_ff)
    for (const b of BUILDINGS) {
      const s = b.side
      const paint = new Color(b.color).lerp(white, 0.5).getHex()
      const fx = s * (H + Bw) // facade plane
      const z0 = b.z - b.w / 2
      const z1 = b.z + b.w / 2
      const bodyCx = fx + (s * b.depth) / 2
      // main body
      walls.box(bodyCx, b.h / 2, b.z, b.depth, b.h, b.w - 0.05, paint, { skip: ['bottom'] })
      // roof: shallow gable running away from the street, hidden by the false front
      trim.gable(bodyCx, b.h, b.z, b.depth, b.w - 0.3, 1.2, 'x', 0x4a_3a_2e, 0.2)
      // false front (taller flat facade)
      const ft = 0.25
      walls.box(fx - (s * ft) / 2, b.front / 2, b.z, ft, b.front, b.w, paint, {
        skip: ['bottom'],
      })
      // cornice
      trim.box(fx - s * 0.35, b.front + 0.12, b.z, 0.6, 0.24, b.w + 0.3, 0x3a_2a_1e)
      trim.box(fx - s * 0.2, b.front - 0.4, b.z, 0.3, 0.12, b.w + 0.1, 0x3a_2a_1e)
      // corner pilasters
      // 1 cm proud of the false front's ends, so their end faces never coincide (z-fighting)
      trim.box(fx - s * 0.3, b.front / 2, z0 + 0.14, 0.3, b.front, 0.3, 0x3a_2a_1e)
      trim.box(fx - s * 0.3, b.front / 2, z1 - 0.14, 0.3, b.front, 0.3, 0x3a_2a_1e)
      // sign board on the false front
      const sy = b.h + (b.front - b.h) * 0.45 + 0.3
      const sw = Math.min(b.w - 1.4, 8.5)
      const sh = 1.0
      const row = b.sign
      const v0 = 1 - (row + 1) / signRows
      const v1 = 1 - row / signRows
      const sx = fx - s * 0.32
      const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
      if (s === 1) {
        signs.quadUV(
          [
            V(sx, sy - sh / 2, b.z + sw / 2),
            V(sx, sy - sh / 2, b.z - sw / 2),
            V(sx, sy + sh / 2, b.z - sw / 2),
            V(sx, sy + sh / 2, b.z + sw / 2),
          ],
          [0, v0, 1, v0, 1, v1, 0, v1],
          0xff_ff_ff,
        )
      } else {
        signs.quadUV(
          [
            V(sx, sy - sh / 2, b.z - sw / 2),
            V(sx, sy - sh / 2, b.z + sw / 2),
            V(sx, sy + sh / 2, b.z + sw / 2),
            V(sx, sy + sh / 2, b.z - sw / 2),
          ],
          [0, v0, 1, v0, 1, v1, 0, v1],
          0xff_ff_ff,
        )
      }
      trim.box(fx - s * 0.28, sy, b.z, 0.08, sh + 0.2, sw + 0.2, 0x2a_1d_14)
      // windows, doors and shutters: the textured kit when it's loaded, plain boxes otherwise
      facade(b, fx, { glass, trim, kit })
      // boardwalk
      // 2 cm past the front and its pilasters at each end, its back end inside the false front
      // (coincident faces z-fought)
      trim.box(s * (H + Bw / 2 - 0.01), DECK / 2, b.z, Bw - 0.02, DECK, b.w + 0.04, 0xc8_b0_90, {
        rotUV: true,
      })
      // awning on posts
      const aw = 3.1
      trim.box(s * (H + Bw / 2 + 0.1), aw, b.z, Bw + 0.4, 0.12, b.w, 0x5a_46_34)
      for (
        let pz = z0 + 0.3;
        pz <= z1 - 0.2;
        pz += (b.w - 0.6) / Math.max(1, Math.round(b.w / 3.2))
      ) {
        // from the deck up to the awning's underside: standing on the one, holding up the other
        trim.box(s * (H + 0.15), (DECK + AWNING) / 2, pz, 0.18, AWNING - DECK, 0.18, 0x4a_38_28)
      }
      // hitching post
      if (b.kind !== 'undertaker') {
        const hz = b.z + (b.side === 1 ? 2 : -2)
        // the posts stand proud of the rail (flush tops z-fought)
        trim.box(s * (H - 0.6), 0.53, hz - 1.2, 0.14, 1.06, 0.14, 0x5a_44_30)
        trim.box(s * (H - 0.6), 0.53, hz + 1.2, 0.14, 1.06, 0.14, 0x5a_44_30)
        trim.box(s * (H - 0.6), 0.95, hz, 0.1, 0.1, 2.6, 0x5a_44_30)
      }
      // saloon swinging doors
      if (b.kind === 'saloon') {
        // batwings hung inside the kit door frame's opening (the saloon has no door leaf)
        for (const dz of [-0.29, 0.29]) {
          const g = new GeoBuilder(1.6)
          g.box(0, 0, Number(dz), 0.05, 1.1, 0.56, 0x7a_4a_2a)
          const door = new Mesh(g.build(), this.trimMat)
          door.position.set(fx - s * 0.4, 1.35, b.z + dz)
          door.castShadow = true
          this.root.add(door)
          this.saloonDoors.push(door)
        }
      }
    }
    // a water trough and a few fence runs at the open end
    trim.box(-8.2, 0.35, 10, 0.9, 0.7, 2.4, 0x5a_44_30)
    trim.box(8.3, 0.35, -16, 0.9, 0.7, 2.4, 0x5a_44_30)

    dressBoardwalks(kit)
    this.tower = new ClockTower(this.root, { trim, glass, kit }, STREET.churchZ, () => {
      // the atlas landed: recapture the town light probe with the real masonry
      const ud = this.scene.userData
      ud.owLightVersion = ((ud.owLightVersion as number | undefined) ?? 0) + 1
    })
    this.bellPos.copy(this.tower.bellPos)
    mergePlaced(kit, this.root, new Map([['KitGlass', this.windowMat]]))
    for (const [name, m] of [
      ['walls', addStatic(this.root, walls, this.wallMat)],
      ['trim', addStatic(this.root, trim, this.trimMat)],
    ] as const) {
      if (m) {
        m.name = name
      }
    }
    const gm = addStatic(this.root, glass, this.windowMat, false)
    if (gm) {
      gm.name = 'windows'
      gm.receiveShadow = false
    }
    addStatic(this.root, signs, this.signMat, false)
  }

  setClock(h: number, m: number): void {
    this.tower?.setClock(h, m)
  }

  /** A stroke of the tower bell (the swing; the sound is the caller's). */
  toll(): void {
    this.tower?.toll()
  }

  /** Recompute everything that depends on time of day. */
  apply(day: number): void {
    this.day = day
    const p = presetAt(day)
    this.preset = p
    const el = (p.sunElev * Math.PI) / 180
    const az = (p.sunAz * Math.PI) / 180
    const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    const lightDir = dir.clone()
    if (lightDir.y < 0.12) {
      lightDir.y = 0.12
    }
    lightDir.normalize()
    this.sun.position.copy(lightDir).multiplyScalar(60)
    this.sun.target.position.set(0, 0, 0)
    this.sun.color.copy(p.sunColor)
    this.sun.intensity = p.sunIntensity
    this.hemi.color.copy(p.hemiSky)
    this.hemi.groundColor.copy(p.hemiGround)
    this.hemi.intensity = p.hemiIntensity
    this.fog.color.copy(p.fog)
    this.fog.near = p.fogNear
    this.fog.far = p.fogFar
    this.skyDome.set({
      zenith: p.zenith,
      horizon: p.fog,
      sunDir: dir,
      sunColor: p.sunColor,
      sunGlow: p.sunGlow,
      stars: p.stars,
      moon: p.moon,
    })
    ATMOS.atmCover.value = p.clouds
    ATMOS.atmShadowK.value = p.cloudShadow
    ATMOS.atmGust.value = 0.7
    this.poolU.owLantern.value = p.lanterns * 1.4
    this.poolU.owWindow.value = p.windows * 0.9
    RIM.color.value.copy(p.rimColor)
    RIM.strength.value = p.rim
    this.windowMat.emissiveIntensity = p.windows * 1.6
    // the dials are lit from behind once the lamps are (dusk on)
    this.tower?.night(Math.min(1, Math.max(0, (p.windows - 0.25) / 0.6)))
    // The renderer picks the LUT pair from owDay, and recaptures the town light
    // probe whenever owLightVersion moves (a few frames, spread out).
    const ud = this.scene.userData
    ud.owDay = day
    // the renderer's aerial perspective and sun shafts
    ud.owHaze = p.haze
    ud.owRays = p.rays
    if (Math.abs(day - this.probeDay) > 0.035) {
      this.probeDay = day
      ud.owLightVersion = ((ud.owLightVersion as number | undefined) ?? 0) + 1
    }
  }

  /** Fog thickening for the windy outlaw (0..1). */
  windyFog(amount: number): void {
    const p = this.preset
    this.fog.near = p.fogNear * (1 - amount * 0.75)
    this.fog.far = p.fogFar * (1 - amount * 0.7)
  }

  /** Two lanterns become fires for the underboss. */
  fires = false

  update(dt: number): void {
    this.time += dt
    tickAtmos(dt)
    this.tower?.update(dt)
    const lv = this.preset.lanterns
    for (const l of this.lanterns) {
      const f =
        0.85 +
        Math.sin(this.time * 9 + l.phase) * 0.06 +
        Math.sin(this.time * 23 + l.phase * 2) * 0.05
      l.light.intensity = lv * l.base * f
    }
    if (this.fires) {
      for (const i of [1, 2]) {
        const l = this.lanterns[i]
        if (!l) {
          continue
        }
        l.light.intensity = 26 * (0.7 + Math.random() * 0.4)
        l.light.color.setHex(0xff_7a_30)
      }
    }
    const sway = Math.sin(this.time * 1.7) * 0.08
    this.saloonDoors.forEach((d, i) => {
      d.rotation.y = (i === 0 ? 1 : -1) * sway * (d.userData.kick ? 6 : 1)
    })
  }

  /** Set the fire state (underboss). */
  setFires(on: boolean): void {
    this.fires = on
    if (!on) {
      for (const l of this.lanterns) {
        l.light.color.setHex(0xff_a8_50)
      }
    }
  }

  /** Shadow frustum tightly around the action. */
  focusShadow(center: Vector3): void {
    const dir = this.sun.position.clone().normalize()
    this.sun.target.position.copy(center)
    this.sun.position.copy(center).addScaledVector(dir, 60)
  }
}

/** How many light pools the street's ground shader carries. */
const POOLS = 24

/**
 * The street's light pools: one under each hanging lantern (flickering, +), and one spilling from
 * each lit storefront and the courthouse doors (steady, -), nearest the duel first.
 */
function streetPools(): Vector4[] {
  const out: Vector4[] = LANTERNS.map(([x, z]) => new Vector4(x * 0.92, z, 4.2, 1))
  const H = STREET.half
  const fronts = [...BUILDINGS].sort((a, b) => Math.abs(a.z) - Math.abs(b.z))
  for (const b of fronts) {
    out.push(new Vector4(b.side * (H + 0.8), b.z, 3.2, -0.55))
  }
  // the courthouse: its doors and the windows either side
  out.push(new Vector4(0, STREET.churchZ - 9, 4.5, -0.9))
  out.push(new Vector4(-5, STREET.churchZ - 8, 3, -0.5))
  out.push(new Vector4(5, STREET.churchZ - 8, 3, -0.5))
  while (out.length < POOLS) {
    out.push(new Vector4(0, -9999, 1, 0))
  }
  return out.slice(0, POOLS)
}
