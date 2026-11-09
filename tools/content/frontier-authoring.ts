/** Reproducible, offline PlayCanvas town authoring from one gameplay/geometry plan. */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dedup, prune, unpartition, weld } from '@gltf-transform/functions'
import { Quat, Vec3 } from 'playcanvas'
import { townWindows } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import { buildGrid, type TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { projectedUv, surfaceMaterial } from './animal-prop-surfaces.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'
import { bankServiceSigns, buildingDetails, surround } from './frontier-architecture.ts'
import { compileFrontierCollision, perimeterSpans, structuralWalls } from './frontier-collision.ts'
import { FrontierGeometry, frontierIO, type Rgb } from './frontier-geometry.ts'
import { frontierFlatGround, frontierGround, frontierGroundTransform } from './frontier-ground.ts'
import { authoredMaterials } from './frontier-materials.ts'
import { coverModel } from './frontier-props.ts'
import { optimizeAsset } from './optimize.ts'

export interface FrontierPlan {
  vegetation: { x: number; z: number; w: number; d: number; top: number }[]
  life: unknown
  schema: number
  title: string
  arrival: [number, number, number]
  layout: TownLayout
  style: { buildingPaint: Record<string, Rgb>; woodTint: Rgb; stoneTint: Rgb }
  tumbleweedPaths: { center: [number, number]; radius: [number, number] }[]
}
const SOURCE = 'tools/art/environments'
function canyonBoundary(g: FrontierGeometry, layout: TownLayout) {
  const root = g.group('Perdition creek fence / rail line / canyon boundaries')
  const size = layout.size
  // North: a cattle fence along the creek. South: a stationary freight consist.
  for (const span of perimeterSpans(size)) {
    g.box(root, 'wood', { ...span, top: span.y1 }, [0.48, 0.42, 0.31])
  }
  for (let x = 0; x < size; x += 4) {
    g.box(root, 'wood', { x, z: 0, w: 0.2, d: 0.7, y0: 0, top: 2.9 }, [0.38, 0.31, 0.22])
  }
  for (let x = 0; x < size; x += 13) {
    g.box(root, 'wood', { x, z: size - 0.5, w: 13, d: 3.2, y0: 0, top: 5.6 }, [0.37, 0.29, 0.23])
    for (const y of [0.45, 3.6, 5.3]) {
      g.box(
        root,
        'wood',
        { x, z: size - 0.56, w: 13, d: 0.12, y0: y, top: y + 0.13 },
        [0.24, 0.21, 0.18],
      )
    }
    g.box(
      root,
      'wood',
      { x: x + 4, z: size - 0.58, w: 4.8, d: 0.1, y0: 0.65, top: 5.2 },
      [0.32, 0.27, 0.21],
    )
  }
}

export async function authorFrontier(output: string): Promise<void> {
  const plan = JSON.parse(
    await readFile(join(SOURCE, 'frontier.plan.json'), 'utf8'),
  ) as FrontierPlan
  const layout = { ...plan.layout, ambient: plan.life } as TownLayout
  const collision = compileFrontierCollision(layout)
  const g = await FrontierGeometry.create(layout.size)
  await authoredMaterials(g)
  const ground = g.group('ground-Perdition')
  g.box(ground, 'ground', frontierFlatGround(layout.size), [0.92, 0.85, 0.7])
  for (const mesh of frontierGround(layout.size)) {
    g.surface(
      ground,
      'ground',
      {
        ...mesh,
        uvs: mesh.positions.flatMap((value, index) => (index % 3 === 1 ? [] : [value / 1.8])),
      },
      [0.92, 0.85, 0.7],
    )
  }
  canyonBoundary(g, layout)
  const groups = new Map(layout.buildings.map((b) => [b.id, g.group(`building-${b.id}`)]))
  for (const b of layout.buildings) {
    const root = groups.get(b.id)
    if (!root) {
      throw new Error(`Missing ${b.id}`)
    }
    const role = ['bank', 'jail', 'church', 'tower'].includes(b.kind) ? 'stone' : 'wood'
    const tint =
      plan.style.buildingPaint[b.id] ??
      (role === 'stone' ? plan.style.stoneTint : plan.style.woodTint)
    for (const wall of structuralWalls({ ...layout, buildings: [b] })) {
      g.box(root, role, { ...wall, top: wall.y1 }, tint)
    }
    buildingDetails(g, plan, b, root)
  }
  for (const box of collision.boxes) {
    if (!box.id.startsWith('deck:')) {
      continue
    }
    const [x, y, z] = box.center
    const [w, h, d] = box.halfExtents
    g.box(
      ground,
      'floor',
      { x: x - w, z: z - d, w: w * 2, d: d * 2, y0: y - h, top: y + h },
      [0.72, 0.61, 0.44],
    )
  }
  for (const mesh of collision.meshes) {
    if (mesh.id.startsWith('roof:') || mesh.id.startsWith('stair:')) {
      g.surface(
        ground,
        'wood',
        mesh,
        mesh.id.startsWith('roof:') ? [0.37, 0.32, 0.27] : [0.75, 0.63, 0.45],
      )
    }
  }
  const props = g.group('Perdition dressed interiors and purposeful cover')
  for (const c of layout.cover) {
    coverModel(g, props, c)
  }
  bankServiceSigns(g, props, layout)
  const plants = g.group('Perdition creek and yard cactus beds')
  for (const plant of plan.vegetation) {
    g.prefab(plants, 'cactus', plant)
  }
  const panes = authorPanes(g, layout, groups)
  g.finish()
  await g.doc.transform(dedup(), weld(), prune(), unpartition())
  await mkdir(output, { recursive: true })
  await authorTumbleweeds(plan, output)
  await frontierIO.write(join(output, 'frontier.glb'), g.doc)
  await writeFile(join(output, 'town.layout.json'), `${JSON.stringify(layout, null, 2)}\n`)
  await writeFile(join(output, 'collision.json'), `${JSON.stringify(collision)}\n`)
  const hash = createHash('sha256')
    .update(await readFile(join(output, 'frontier.glb')))
    .digest('hex')
  await writeFile(
    join(output, 'frontier.json'),
    `${JSON.stringify(
      {
        schema: plan.schema,
        sourceHash: hash,
        collisionVersion: collision.version,
        arrival: plan.arrival,
        life: plan.life,
        terrain: {
          ...frontierGroundTransform(layout.size),
          referenceHash: createHash('sha256')
            .update(await readFile(join(SOURCE, 'frontier-ground.json')))
            .digest('hex'),
        },
        tumbleweedPaths: plan.tumbleweedPaths,
        panes: panes.length,
      },
      null,
      2,
    )}\n`,
  )
  console.log(
    JSON.stringify({
      output,
      sourceHash: hash,
      collisionVersion: collision.version,
      panes: panes.length,
      meshes: g.doc.getRoot().listMeshes().length,
      materials: g.doc.getRoot().listMaterials().length,
    }),
  )
}
if (import.meta.main) {
  if (process.argv[2] === '--publish') {
    await publishFrontier(process.argv[3] ?? '/tmp/out-west-frontier-staged')
  } else {
    await authorFrontier(process.argv[2] ?? '/tmp/out-west-frontier-staged')
  }
}

function authorPanes(
  g: FrontierGeometry,
  layout: TownLayout,
  groups: Map<string, import('@gltf-transform/core').Node>,
) {
  const panes = buildGrid(layout).glass
  for (const pane of panes) {
    const along = (pane.a0 + pane.a1) / 2
    const cy = (pane.y0 + pane.y1) / 2
    const pos: [number, number, number] =
      pane.axis === 0 ? [pane.at, cy, along] : [along, cy, pane.at]
    const root = g.group(`window-glass-${pane.index}`).setTranslation(pos)
    const w = (pane.a1 - pane.a0) / 2
    const h = (pane.y1 - pane.y0) / 2
    g.quad(
      root,
      'glass',
      pane.axis === 0
        ? [
            [0, -h, -w],
            [0, -h, w],
            [0, h, w],
            [0, h, -w],
          ]
        : [
            [-w, -h, 0],
            [w, -h, 0],
            [w, h, 0],
            [-w, h, 0],
          ],
      {
        uvs: [
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      },
    )
    const building = townWindows(layout).find((entry) => entry.index === pane.index)?.b
    const frame = building ? groups.get(building.id) : undefined
    if (frame) {
      surround(g, frame, {
        side: pane.axis === 0 ? 'e' : 's',
        tint: [0.76, 0.65, 0.47],
        x: pane.axis === 0 ? pane.at : pane.a0,
        z: pane.axis === 0 ? pane.a0 : pane.at,
        width: pane.a1 - pane.a0,
        y0: pane.y0,
        y1: pane.y1,
      })
    }
  }
  return panes
}

async function authorTumbleweeds(plan: FrontierPlan, output: string) {
  const doc = await frontierIO.read(join(SOURCE, 'frontier-tumbleweeds.glb'))
  await dressTumbleweeds(doc)
  for (const animation of doc.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const path = channel.getTargetPath()
      if (path !== 'translation' && path !== 'rotation') {
        continue
      }
      const index = Number(channel.getTargetNode()?.getName().split('-').at(-1))
      const route = plan.tumbleweedPaths[index]
      const sampler = channel.getSampler()
      const input = sampler?.getInput()
      const values = sampler?.getOutput()
      if (!(route && input && values)) {
        throw new Error('Missing canonical tumbleweed route')
      }
      const duration = input.getScalar(input.getCount() - 1)
      for (let frame = 0; frame < input.getCount(); frame++) {
        const angle = (input.getScalar(frame) / duration) * Math.PI * 2
        const x = route.center[0] + Math.cos(angle) * route.radius[0]
        const radius = 0.35 + index * 0.06
        if (path === 'translation') {
          values.setElement(frame, [x, radius, route.center[1] + Math.sin(angle) * route.radius[1]])
        } else {
          const turn = ((-(x - route.center[0] - route.radius[0]) / radius) * 180) / Math.PI
          const q = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), turn)
          values.setElement(frame, [q.x, q.y, q.z, q.w])
        }
      }
    }
  }
  await frontierIO.write(join(output, 'frontier-tumbleweeds.glb'), doc)
}

async function dressTumbleweeds(doc: import('@gltf-transform/core').Document) {
  for (const material of doc.getRoot().listMaterials()) {
    if (!material.getBaseColorTexture()) {
      await surfaceMaterial(doc, 'straw', material.getName())
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          if (primitive.getMaterial() === material) {
            projectedUv(doc, primitive, 8)
          }
        }
      }
    }
  }
}

/** Publish only validated map artifacts. Shared manifest generation remains the final integration step. */
export async function publishFrontier(directory: string): Promise<void> {
  const [audit, metadata, layout, plan] = await Promise.all(
    [
      'native-layout-audit.json',
      'frontier.json',
      'town.layout.json',
      'tools/art/environments/frontier.plan.json',
    ].map(async (name, index) =>
      JSON.parse(await readFile(index === 3 ? name : join(directory, name), 'utf8')),
    ),
  )
  if (audit.issues.length > 0 || audit.collisionVersion !== metadata.collisionVersion) {
    throw new Error('Native map audit is missing or stale')
  }
  const collision = JSON.parse(await readFile(join(directory, 'collision.json'), 'utf8'))
  if (JSON.stringify(collision) !== JSON.stringify(compileFrontierCollision(layout))) {
    throw new Error('Stale native collision output')
  }
  const sourceBytes = await readFile(join(directory, 'frontier.glb'))
  if (createHash('sha256').update(sourceBytes).digest('hex') !== metadata.sourceHash) {
    throw new Error('Source changed after native map audit')
  }
  if (JSON.stringify(layout) !== JSON.stringify({ ...plan.layout, ambient: plan.life })) {
    throw new Error('Rebuild after changing the canonical plan')
  }
  const native = await frontierIO.read(join(directory, 'baked/frontier.glb'))
  if (native.getRoot().getExtras().frontierSourceHash !== metadata.sourceHash) {
    throw new Error('Native bake is not from the current authored source')
  }
  const ambient = join(directory, 'native-frontier-tumbleweeds.glb')
  await copyFile(join(directory, 'frontier-tumbleweeds.glb'), ambient)
  await optimizeAsset(ambient)
  await compressEnvironmentTextures(ambient)
  const files = [
    [join(directory, 'frontier.glb'), join(SOURCE, 'frontier.glb')],
    [join(directory, 'frontier.json'), join(SOURCE, 'frontier.json')],
    [join(directory, 'frontier-tumbleweeds.glb'), join(SOURCE, 'frontier-tumbleweeds.glb')],
    [join(directory, 'town.layout.json'), 'src/experiments/out-west/ffa/town.layout.json'],
    [join(directory, 'collision.json'), 'src/experiments/out-west/content/collision.json'],
    [
      join(directory, 'baked/frontier.glb'),
      'public/experiments/out-west/3d/native-v2/baked/frontier.glb',
    ],
    [ambient, 'public/experiments/out-west/3d/native-v2/ambient/frontier-tumbleweeds.glb'],
  ] as const
  for (const [from, to] of files) {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, `${to}.frontier-next`)
  }
  for (const [, to] of files) {
    await rename(`${to}.frontier-next`, to)
  }
  console.log(
    'Published coherent Frontier map artifacts; regenerate shared content manifest before build/deploy.',
  )
}
