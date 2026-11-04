// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one page script, top to bottom
/**
 * The long guns on a bench: the Winchester carbine and the coach gun rendered on their own under
 * a studio light (three's RoomEnvironment and a key), from the left, the right, three-quarter
 * and close on the action, so their shapes and finishes can be judged without a level around
 * them. The modules are imported into a page from the dev server (no game code runs).
 *
 *   bun --bun astro dev --port 4401 --ignore-lock
 *   bun tools/gun-studio.ts [baseUrl] [--tag=after]
 *
 * Writes `.playwright-mcp/guns-<tag>-studio.png` and prints each gun's triangle count.
 */
import { mkdirSync } from 'node:fs'
import process from 'node:process'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
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
  const guns = [r, lo, s]
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
  view(lo, [1200, 300, 400, 300], [0.18, -0.03, 2.4, 24], [0.18, -0.03, 0])
  // coach gun: left, right, three-quarter, the locks close
  view(s, [0, 600, 800, 300], [0.1, -0.01, -1.25, 24], [0.1, -0.01, 0])
  view(s, [800, 600, 800, 300], [0.1, -0.01, 1.25, 24], [0.1, -0.01, 0])
  view(s, [0, 900, 800, 300], [0.75, 0.45, 0.8, 30], [0.1, 0, 0])
  view(s, [800, 900, 800, 300], [0.0, 0.08, 0.4, 34], [0.0, 0.02, 0])
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
await browser.close()
