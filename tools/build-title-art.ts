#!/usr/bin/env bun
/**
 * The title-screen key art: a two-ink relief print of the duel street, built as an SVG.
 *
 *   bun tools/build-title-art.ts [out.svg]
 *
 * The scene is the game's own: the duel street seen from its middle, a low sun behind the brick
 * courthouse clock tower (hands at noon) at the far end, timber false fronts and porches down both
 * sides, telegraph poles, mesas on the horizon, and two gunmen
 * squared up with their shadows running at the viewer. Buildings are placed in true perspective
 * (one camera, one vanishing point); every figure and ornament is drawn here by hand as geometry.
 *
 * It prints like a block cut in two plates on the title's paper: a vermilion plate (sky, false
 * fronts) and a black key plate (everything else). Light areas are carved out of the plates as
 * masks, and each figure has a paper halo cut around it. The plates are roughened and worn by an
 * SVG filter (ink spread, speckle) and the red is laid slightly off register. No lettering: the
 * title sheet's real type does the talking.
 *
 * Output: public/experiments/out-west/ui/title-duel.svg (the --ow-img-woodcut token).
 */
import { writeFile } from 'node:fs/promises'
import { courthouse } from './title-art/courthouse.ts'
import { GUNMEN, gunmanPts, shadowPts } from './title-art/gunmen.ts'
import {
  circle,
  FOCAL,
  gouge,
  H,
  HORIZON,
  INK,
  jitter,
  n1,
  type Pt,
  poly,
  proj,
  RED,
  rand,
  rect,
  VPX,
  W,
} from './title-art/print.ts'
import { street } from './title-art/street.ts'

/* ----------------------------------------------------------- wires and mesas */
function telegraph(): { poles: string[]; wires: string[] } {
  const poles: string[] = []
  const wires: string[] = []
  const x = 6.75
  const zs = [9.4, 18.4, 27.4, 36.4, 45.4]
  for (const z of zs) {
    const w = Math.max(1.4, (FOCAL * 0.24) / z)
    const a = proj(x, 0, z)
    const b = proj(x, 7.6, z)
    poles.push(
      poly([
        [a[0] - w / 2, a[1]],
        [a[0] + w / 2, a[1]],
        [b[0] + w * 0.35, b[1]],
        [b[0] - w * 0.35, b[1]],
      ]),
    )
    const arm = 0.06
    poles.push(
      poly([
        proj(x - 0.9, 7.05, z),
        proj(x + 0.9, 7.05, z),
        proj(x + 0.9, 7.05 + arm * 3, z),
        proj(x - 0.9, 7.05 + arm * 3, z),
      ]),
    )
    for (const dx of [-0.75, -0.25, 0.25, 0.75]) {
      const c = proj(x + dx, 7.32, z)
      const r = Math.max(0.8, (FOCAL * 0.07) / z)
      poles.push(poly(rect(c[0] - r, c[1] - r * 1.4, c[0] + r, c[1] + r * 0.6)))
    }
  }
  for (const dx of [-0.75, 0.75, -0.25, 0.25]) {
    for (let i = 0; i < zs.length; i++) {
      const z0 = zs[i] ?? 0
      const z1 = zs[i + 1] ?? 70
      const pts: Pt[] = []
      for (let k = 0; k <= 16; k++) {
        const s = k / 16
        const z = z0 + (z1 - z0) * s
        pts.push(proj(x + dx, 7.32 - Math.sin(s * Math.PI) * 0.45, z))
      }
      const wpx = Math.max(0.5, (FOCAL * 0.02) / z0)
      wires.push(
        `<path d="M${pts.map(([px, py]) => `${n1(px)} ${n1(py)}`).join('L')}" stroke-width="${n1(wpx)}"/>`,
      )
    }
  }
  // the near pole runs off the top of the print; one wire comes in from beyond the frame
  return { poles, wires }
}

function mesas(): { body: string[]; carve: string[]; rim: string } {
  // two flat-topped mesas either side of the tower, cap rock over a talus slope (x in print px,
  // height above the horizon in px), and a low ridge between them
  const ridge: Pt[] = [
    [330, 0],
    [350, 40],
    [372, 62],
    [388, 104],
    [398, 150],
    [404, 157],
    [512, 159],
    [518, 151],
    [522, 128],
    [536, 116],
    [560, 96],
    [600, 72],
    [640, 58],
    [690, 52],
    [760, 54],
    [800, 60],
    [836, 84],
    [852, 108],
    [862, 136],
    [868, 156],
    [874, 163],
    [970, 165],
    [976, 156],
    [982, 124],
    [1004, 100],
    [1030, 74],
    [1060, 30],
    [1080, 0],
  ]
  const pts: Pt[] = ridge.map(([x, h]) => [x, HORIZON + 4 - h])
  const body = [poly([[330, HORIZON + 6], ...pts, [1080, HORIZON + 6]])]
  const carve: string[] = []
  // a line tint: open near the tops, closing up toward the horizon
  for (let y = HORIZON - 168; y < HORIZON + 4; y += 3.4) {
    const t = (y - HORIZON + 168) / 172
    carve.push(poly(rect(320, y, 1090, y + 2 - t * 1.2)))
  }
  const rim = `M${pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join('L')}`
  return { body, carve, rim }
}

/* ------------------------------------------------------------ sky and ground */
const SUN: Pt = [VPX, HORIZON - 92]
const SUN_R = 172

/** Engraved sky: horizontal cuts that swell toward the horizon, each one a tapered gouge. */
function sky(): string[] {
  const out: string[] = []
  let y = 52
  while (y < HORIZON + 2) {
    const t = (y - 52) / (HORIZON - 52)
    const weight = 0.5 + 3.6 * t ** 1.6
    const segs = 2 + Math.floor(rand() * 2)
    // lines thin out and break up as they climb; their ends are ragged by hand
    const reach = 520 + 780 * Math.min(1, t * 1.6 + 0.2)
    const x0 = VPX - reach / 2 + jitter(40)
    const x1 = VPX + reach / 2 + jitter(40)
    let a = x0
    for (let s = 0; s < segs; s++) {
      const b = s === segs - 1 ? x1 : a + (x1 - x0) / segs + jitter(60)
      out.push(gouge([a, y + jitter(0.4)], [b, y + jitter(0.4)], weight * (0.85 + rand() * 0.3)))
      a = b + 6 + rand() * 14 * (1 - t)
    }
    y += 6.4 + 3.2 * (1 - t) + jitter(0.5)
  }
  return out
}

/** The sun is solid vermilion, cut across its lower half in widening bands. */
function sunCuts(): string[] {
  const out: string[] = []
  const [cx, cy] = SUN
  let y = cy - SUN_R * 0.42
  let k = 0
  while (y < cy + SUN_R) {
    const w = 1.2 + k * 0.85
    const dy = y - cy
    const half = Math.sqrt(Math.max(0, SUN_R * SUN_R - dy * dy)) + 4
    out.push(poly(rect(cx - half, y, cx + half, y + w)))
    y += w + 9 - k * 0.45
    k++
  }
  return out
}

function ground(): string[] {
  const out: string[] = []
  // wheel ruts, broken where the wheels lifted
  for (const rx of [-1.55, -0.85, 0.9, 1.6]) {
    let z = 4
    while (z < 52) {
      const len = 2.5 + rand() * z * 0.5
      const z1 = Math.min(52, z + len)
      const a = proj(rx + jitter(0.03), 0, z)
      const b = proj(rx + jitter(0.03), 0, z1)
      out.push(gouge(a, b, Math.max(0.6, (FOCAL * 0.034) / z)))
      z = z1 + 0.6 + rand() * z * 0.18
    }
  }
  // the dirt: short horizontal cuts, denser and bigger toward the viewer
  for (let i = 0; i < 300; i++) {
    const z = 4 + rand() ** 1.7 * 44
    const x = jitter(5.7)
    const len = 0.12 + rand() * 0.42
    const a = proj(x - len / 2, 0, z)
    const b = proj(x + len / 2, 0, z + jitter(0.1))
    out.push(gouge(a, b, Math.max(0.5, (FOCAL * (0.01 + rand() * 0.014)) / z)))
  }
  return out
}

/* --------------------------------------------------------------- the print */
function svg(): string {
  const st = street()
  const civic = courthouse()
  const mesa = mesas()
  const wire = telegraph()
  const men = GUNMEN.map(gunmanPts)
  const shadows = GUNMEN.map(shadowPts)
  const menPaths = men.map(poly)
  const shadowPaths = shadows.map(poly)

  const halo = (d: string, w: number): string =>
    `<path d="${d}" stroke="#000" stroke-width="${w}" stroke-linejoin="round"/>`
  const fill = (ds: readonly string[], color: string): string =>
    `<path fill="${color}" d="${ds.join('')}"/>`

  // the shadows: solid at the feet, carved into lines toward the viewer
  const shadowCarve: string[] = []
  for (let y = HORIZON + 140; y < H; y += 4.4) {
    const t = (y - HORIZON - 140) / (H - HORIZON - 140)
    shadowCarve.push(poly(rect(0, y, W, y + 0.5 + t * 1.6)))
  }

  const ink = `<filter id="i" x="0" y="0" width="${W}" height="${H}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="d"/><feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="3" seed="19"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 40 0 0 0 -12.7" result="w"/><feComposite in="d" in2="w" operator="in"/></filter>`

  const maskRect = `<rect width="${W}" height="${H}" fill="#fff"/>`
  const masks = [
    // the red plate: carved light, paper halos round everything that stands in front of it
    `<mask id="mr" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<g fill="#000"><path d="${st.carveRed.join('')}"/>${halo(civic.body.join(''), 7)}${halo(wire.poles.join(''), 4)}${menPaths.map((d) => halo(d, 9)).join('')}</g></mask>`,
    // the sun's bands
    `<mask id="mu" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<path fill="#000" d="${sunCuts().join('')}"/></mask>`,
    // the sky's cuts stop short of the sun
    `<mask id="mk" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<path fill="#000" d="${circle(SUN, SUN_R + 9)}"/></mask>`,
    // the mesas are cut to a line tint: they sit back behind everything else
    `<mask id="mm" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<path fill="#000" d="${mesa.carve.join('')}"/></mask>`,
    // the far black (mesas): hidden by the fronts and haloed by the courthouse
    `<mask id="mf" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<g fill="#000"><path d="${st.occluders.join('')}"/>${halo(civic.body.join(''), 7)}${menPaths.map((d) => halo(d, 9)).join('')}</g></mask>`,
    // the near black (street, courthouse): carved frames, haloed by the gunmen
    `<mask id="mn" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<g fill="#000"><path d="${st.carveBlack.join('')}${civic.carve.join('')}"/>${menPaths.map((d) => halo(d, 9)).join('')}</g></mask>`,
    // the shadows: carved into lines as they come at the viewer
    `<mask id="ms" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${maskRect}<path fill="#000" d="${shadowCarve.join('')}"/></mask>`,
  ]

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">`,
    `<defs>${ink}<clipPath id="hz"><rect width="${W}" height="${HORIZON}"/></clipPath>${masks.join('')}</defs>`,
    // vermilion plate, laid a hair off register
    `<g filter="url(#i)" opacity=".94"><g transform="translate(2.2 1.3)" mask="url(#mr)">`,
    `<g mask="url(#mk)">${fill(sky(), RED)}</g>`,
    `<g clip-path="url(#hz)"><path fill="${RED}" mask="url(#mu)" d="${circle(SUN, SUN_R)}"/></g>`,
    fill(st.red, RED),
    '</g></g>',
    // key plate
    `<g filter="url(#i)" fill="${INK}">`,
    `<g mask="url(#mf)"><path mask="url(#mm)" d="${mesa.body.join('')}"/><path fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round" d="${mesa.rim}"/></g>`,
    `<g mask="url(#mn)">${fill(st.black, INK)}${fill(civic.body, INK)}${fill(wire.poles, INK)}<g fill="none" stroke="${INK}" stroke-linecap="round">${wire.wires.join('')}</g>${fill(ground(), INK)}</g>`,
    `<path d="${civic.dial.join('')}" fill-rule="evenodd"/>`,
    `<g mask="url(#ms)">${fill(shadowPaths, INK)}</g>`,
    fill(menPaths, INK),
    '</g></svg>',
  ].join('')
}

const target = process.argv[2] ?? 'public/experiments/out-west/ui/title-duel.svg'
const text = svg()
await writeFile(target, `${text}\n`)
console.log(`${target}: ${(text.length / 1024).toFixed(1)} KB`)
