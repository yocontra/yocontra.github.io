/** Seat the authored fence parts in the same spans used for native collision. */
import { type Document, Material, Node } from '@gltf-transform/core'
import { copyToDocument } from '@gltf-transform/functions'
import type { Cover, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { fenceSpans, type Structure } from './frontier-collision.ts'
import { type FrontierGeometry, frontierIO } from './frontier-geometry.ts'

export function hasFittedFence(cover: Cover): boolean {
  return cover.kind === 'fence' || cover.kind === 'bars'
}

function fitSpan(node: Node, span: Structure, turned: boolean, rail: boolean): void {
  const height = span.y1 - span.y0
  node
    .setTranslation([span.x + span.w / 2, span.y0 + (rail ? height / 2 : 0), span.z + span.d / 2])
    .setScale(rail ? [turned ? span.d : span.w, height / 0.09, 1] : [1, height, 1])
  if (turned) {
    node.setRotation([0, -Math.SQRT1_2, 0, Math.SQRT1_2])
  }
}

function fenceTemplates(geometry: FrontierGeometry, art: Document): Map<string, Node> {
  const templates = art.getRoot().getDefaultScene()?.listChildren() ?? []
  const parts = copyToDocument(geometry.doc, art, templates)
  for (const material of art.getRoot().listMaterials()) {
    const surface = parts.get(material)
    const scan = geometry.materials.get(material.getName().includes('oak') ? 'floor' : 'iron')
    if (!(surface instanceof Material && scan?.getNormalTexture())) {
      throw new Error(`Missing the fence scan for ${material.getName()}`)
    }
    surface
      .setBaseColorTexture(scan.getBaseColorTexture())
      .setNormalTexture(scan.getNormalTexture())
      .setNormalScale(0.56)
      .setOcclusionTexture(scan.getOcclusionTexture())
  }
  const named = new Map<string, Node>()
  for (const source of templates) {
    const template = parts.get(source)
    if (!(template instanceof Node)) {
      throw new Error(`Could not copy fence profile ${source.getName()}`)
    }
    named.set(source.getName(), template)
  }
  return named
}

export async function installFrontierFences(
  geometry: FrontierGeometry,
  layout: TownLayout,
  path: string,
): Promise<void> {
  const templates = fenceTemplates(geometry, await frontierIO.read(path))
  const root = geometry.group('Split-oak fences and forged grilles')
  for (const [i, site] of layout.cover.entries()) {
    if (!hasFittedFence(site)) {
      continue
    }
    for (const span of fenceSpans(site)) {
      const rail = span.id.startsWith('rail:')
      const [post, beam] =
        site.kind === 'bars'
          ? ['riveted-grille-upright', 'riveted-grille-rail']
          : ['split-oak-post', 'split-oak-rail']
      const name = rail ? beam : post
      const template = templates.get(name)
      if (!(template instanceof Node)) {
        throw new Error(`Missing fence profile ${name}`)
      }
      const part = geometry.doc.createNode(`frontier-fence:${i}:${span.id}`)
      for (const child of template.listChildren()) {
        part.addChild(
          geometry.doc
            .createNode(child.getName())
            .setMesh(child.getMesh())
            .setMatrix(child.getMatrix()),
        )
      }
      fitSpan(part, span, site.d > site.w, rail)
      root.addChild(part)
    }
  }
  for (const template of templates.values()) {
    for (const child of template.listChildren()) {
      child.dispose()
    }
    template.dispose()
  }
}
