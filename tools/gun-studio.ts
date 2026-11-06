// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one page script, top to bottom
/**
 * The guns on a bench: the Winchester carbine and the coach gun rendered on their own under
 * a studio light (three's RoomEnvironment and a key), from the left, the right, three-quarter
 * and close on the action, the far level of detail, and the first-person pair articulated (the
 * lever thrown, the barrels broken open), so their shapes and finishes can be judged without a level around
 * them. The modules are imported into a page from the dev server (no game code runs).
 *
 *   bun --bun astro dev --port 4401 --ignore-lock
 *   bun tools/gun-studio.ts [baseUrl] [--tag=after]
 *
 * Then the Peacemaker (scene/revolver.ts): both sides, three-quarter, the chambers from the front,
 * the sights from behind and the action close (cocked, the cylinder turned), its three levels of
 * detail, and a Buntline and a nickel-and-ivory finish.
 *
 * Writes `.playwright-mcp/guns-<tag>-studio.png` and `guns-<tag>-revolver.png`, and prints each
 * gun's triangle count.
 */
import { mkdirSync } from 'node:fs'
import process from 'node:process'
import { chromium } from 'playwright'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4401'
const tag = process.argv.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'after'
const OUT = '.playwright-mcp'

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } })
page.on('pageerror', (e) => console.log(`  page error: ${e.message}`))
// a light page from the dev server, only for its module graph
await page.goto(`${base}/experiments/`)
const MODULES = {
  three: '/node_modules/three/build/three.module.js',
  room: '/node_modules/three/examples/jsm/environments/RoomEnvironment.js',
  rifle: '/src/experiments/out-west/scene/rifle.ts',
  shotgun: '/src/experiments/out-west/ffa/scene/shotgun.ts',
}
const tris = await page.evaluate(async (urls) => {
  const T = (await import(/* @vite-ignore */ urls.three)) as typeof import('three')
  const { RoomEnvironment } = (await import(
    /* @vite-ignore */ urls.room
  )) as typeof import('three/examples/jsm/environments/RoomEnvironment.js')
  const rifle = (await import(
    /* @vite-ignore */ urls.rifle
  )) as typeof import('../src/experiments/out-west/scene/rifle.ts')
  const shotgun = (await import(
    /* @vite-ignore */ urls.shotgun
  )) as typeof import('../src/experiments/out-west/ffa/scene/shotgun.ts')
  document.body.innerHTML = ''
  document.body.style.margin = '0'
  const W = 1600
  const H = 1200
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  document.body.append(canvas)
  const gl = new T.WebGLRenderer({ canvas, antialias: true })
  gl.setSize(W, H, false)
  gl.toneMapping = T.ACESFilmicToneMapping
  gl.outputColorSpace = T.SRGBColorSpace
  gl.setScissorTest(true)
  const scene = new T.Scene()
  scene.background = new T.Color(0x8a_8a_86)
  const pmrem = new T.PMREMGenerator(gl)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.6
  const key = new T.DirectionalLight(0xff_f0_dd, 2.4)
  key.position.set(1, 2, 1.5)
  scene.add(key, new T.HemisphereLight(0xdd_e8_ff, 0x6b_4e_33, 0.5))
  const r = rifle.rifleObject()
  const lo = new T.Mesh(rifle.rifleGeometry('lo'), (r as import('three').Mesh).material)
  const s = shotgun.shotgunMesh()
  // the first-person guns: the lever thrown, the barrels broken open
  const ra = rifle.rifleObject({ lever: true })
  const lever = ra.getObjectByName('lever')
  if (lever) {
    lever.rotation.z = 0.55
  }
  const sa = shotgun.shotgunMesh(undefined, true)
  const barrels = sa.getObjectByName('barrels')
  if (barrels) {
    barrels.rotation.z = -0.5
  }
  const guns = [r, lo, s, ra, sa]
  for (const g of guns) {
    g.visible = false
    scene.add(g)
  }
  const cam = new T.PerspectiveCamera(20, 1, 0.01, 20)
  /** One gun into one tile of the sheet: [x, y, w, h] in pixels, the eye and its fov, the look-at. */
  const view = (
    g: import('three').Object3D,
    tile: readonly [number, number, number, number],
    eye: readonly [number, number, number, number],
    at: readonly [number, number, number],
  ): void => {
    const [x, y, w, h] = tile
    for (const o of guns) {
      o.visible = o === g
    }
    cam.fov = eye[3]
    cam.aspect = w / h
    cam.updateProjectionMatrix()
    cam.position.set(eye[0], eye[1], eye[2])
    cam.lookAt(...at)
    gl.setViewport(x, H - y - h, w, h)
    gl.setScissor(x, H - y - h, w, h)
    gl.render(scene, cam)
  }
  // rifle: left side, right side, three-quarter from above, the action close; the far LOD
  view(r, [0, 0, 800, 300], [0.18, -0.03, -1.25, 24], [0.18, -0.03, 0])
  view(r, [800, 0, 800, 300], [0.18, -0.03, 1.25, 24], [0.18, -0.03, 0])
  view(r, [0, 300, 800, 300], [0.75, 0.42, 0.85, 30], [0.17, -0.03, 0])
  view(r, [800, 300, 400, 300], [0.02, 0.0, 0.42, 30], [0.02, -0.03, 0])
  view(lo, [1200, 300, 400, 150], [0.18, -0.03, 2.4, 24], [0.18, -0.03, 0])
  view(ra, [1200, 450, 400, 150], [0.1, -0.05, -0.9, 30], [0.08, -0.06, 0])
  // coach gun: left, right, three-quarter, the locks close
  view(s, [0, 600, 800, 300], [0.1, -0.01, -1.25, 24], [0.1, -0.01, 0])
  view(s, [800, 600, 800, 300], [0.1, -0.01, 1.25, 24], [0.1, -0.01, 0])
  view(s, [0, 900, 800, 300], [0.75, 0.45, 0.8, 30], [0.1, 0, 0])
  view(s, [800, 900, 400, 300], [0.0, 0.08, 0.4, 34], [0.0, 0.02, 0])
  view(sa, [1200, 900, 400, 300], [0.1, 0.1, 1.1, 30], [0.08, -0.02, 0])
  const count = (g: import('three').BufferGeometry) =>
    (g.index ? g.index.count : g.getAttribute('position').count) / 3
  return {
    rifle: count(rifle.rifleGeometry('hi')),
    rifleLod: count(rifle.rifleGeometry('lo')),
    shotgun: count(shotgun.shotgunGeometry()),
  }
}, MODULES)
await page.screenshot({ path: `${OUT}/guns-${tag}-studio.png` })
console.log(`  ${OUT}/guns-${tag}-studio.png`)
console.log(`  triangles: ${JSON.stringify(tris)}`)
// ---- the revolver's sheet
await page.goto(`${base}/experiments/`)
const revolverTris = await page.evaluate(
  async (urls) => {
    const T = (await import(/* @vite-ignore */ urls.three)) as typeof import('three')
    const { RoomEnvironment } = (await import(
      /* @vite-ignore */ urls.room
    )) as typeof import('three/examples/jsm/environments/RoomEnvironment.js')
    const rv = (await import(
      /* @vite-ignore */ urls.revolver
    )) as typeof import('../src/experiments/out-west/scene/revolver.ts')
    const gs = (await import(
      /* @vite-ignore */ urls.gunsmith
    )) as typeof import('../src/experiments/out-west/scene/gunsmith.ts')
    document.body.innerHTML = ''
    document.body.style.margin = '0'
    const W = 1600
    const H = 1200
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    document.body.append(canvas)
    const gl = new T.WebGLRenderer({ canvas, antialias: true })
    gl.setSize(W, H, false)
    gl.toneMapping = T.ACESFilmicToneMapping
    gl.outputColorSpace = T.SRGBColorSpace
    gl.setScissorTest(true)
    const scene = new T.Scene()
    scene.background = new T.Color(0x8a_8a_86)
    scene.environment = new T.PMREMGenerator(gl).fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.6
    const key = new T.DirectionalLight(0xff_f0_dd, 2.4)
    key.position.set(1, 2, 1.5)
    scene.add(key, new T.HemisphereLight(0xdd_e8_ff, 0x6b_4e_33, 0.5))
    const S = 0.3
    const g = rv.revolverObject({ size: S })
    const mid = rv.revolverObject({ size: S, detail: 'mid' })
    const lo = rv.revolverObject({ size: S, detail: 'lo' })
    const art = rv.revolverObject({ size: S, articulated: true })
    const hammer = art.getObjectByName('hammer')
    if (hammer) {
      hammer.rotation.z = rv.HAMMER_COCK
    }
    const cyl = art.getObjectByName('cylinder')
    if (cyl) {
      cyl.rotation.x = 0.4
    }
    const bunt = rv.revolverObject({ size: S, look: { ...rv.PEACEMAKER, barrel: 12 } })
    const ivory: import('../src/experiments/out-west/scene/gunsmith.ts').Finish = {
      band: 4,
      rgb: [0.98, 0.92, 0.8],
      metal: 0,
      rough: 0.36,
    }
    const nickel = rv.revolverObject({
      size: S,
      look: { barrel: 5.5, steel: gs.NICKEL, frame: gs.NICKEL, guard: gs.NICKEL, grip: ivory },
    })
    const guns = [g, mid, lo, art, bunt, nickel]
    for (const o of guns) {
      o.visible = false
      scene.add(o)
    }
    const rear = (g.userData.gunAnatomy as { rear: { y: number } }).rear
    const cam = new T.PerspectiveCamera(20, 1, 0.005, 20)
    const view = (
      o: import('three').Object3D,
      tile: readonly [number, number, number, number],
      eye: readonly [number, number, number, number],
      at: readonly [number, number, number],
    ): void => {
      const [x, y, w, h] = tile
      for (const q of guns) {
        q.visible = q === o
      }
      cam.fov = eye[3]
      cam.aspect = w / h
      cam.updateProjectionMatrix()
      cam.position.set(eye[0], eye[1], eye[2])
      cam.lookAt(...at)
      gl.setViewport(x, H - y - h, w, h)
      gl.setScissor(x, H - y - h, w, h)
      gl.render(scene, cam)
    }
    view(g, [0, 0, 800, 400], [0, 0.07, 1, 22], [0, 0.07, 0])
    view(g, [800, 0, 800, 400], [0, 0.07, -1, 22], [0, 0.07, 0])
    view(g, [0, 400, 800, 400], [0.45, 0.35, 0.55, 30], [0, 0.07, 0])
    view(g, [800, 400, 400, 400], [0.5, 0.12, 0.12, 22], [0.1, 0.11, 0])
    view(art, [1200, 400, 400, 400], [-0.35, 0.16, 0, 22], [0.05, rear.y, 0])
    view(art, [0, 800, 600, 400], [-0.05, 0.11, 0.45, 26], [-0.04, 0.08, 0])
    view(mid, [600, 800, 500, 200], [0, 0.07, 1.2, 22], [0, 0.07, 0])
    view(lo, [600, 1000, 500, 200], [0, 0.07, 1.2, 22], [0, 0.07, 0])
    view(bunt, [1100, 800, 500, 200], [0.06, 0.07, 1.5, 22], [0.06, 0.07, 0])
    view(nickel, [1100, 1000, 500, 200], [0, 0.07, 1.2, 22], [0, 0.07, 0])
    const count = (o: import('three').Object3D): number => {
      let n = 0
      o.traverse((m) => {
        const mesh = m as import('three').Mesh
        if (mesh.isMesh) {
          const geo = mesh.geometry
          n += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3
        }
      })
      return n
    }
    return { hi: count(g), mid: count(mid), lo: count(lo) }
  },
  {
    ...MODULES,
    revolver: '/src/experiments/out-west/scene/revolver.ts',
    gunsmith: '/src/experiments/out-west/scene/gunsmith.ts',
  },
)
await page.screenshot({ path: `${OUT}/guns-${tag}-revolver.png` })
console.log(`  ${OUT}/guns-${tag}-revolver.png`)
console.log(`  revolver triangles: ${JSON.stringify(revolverTris)}`)
await browser.close()
