/** Native animation layers require compatible TRS channels when dense baked poses mix with
 * the original sparse clips. Fill absent channels with the authored rig's rest transform;
 * never mutate a shared runtime AnimTrack or synthesize poses in the renderer.
 */
import type { Document, Node } from '@gltf-transform/core'

export function completeCharacterClips(doc: Document): void {
  const nodes = new Set<Node>()
  for (const animation of doc.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode()
      if (node) {
        nodes.add(node)
      }
    }
  }
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  for (const animation of doc.getRoot().listAnimations()) {
    const duration = Math.max(
      ...animation.listSamplers().map((sampler) => sampler.getInput()?.getMax([])[0] ?? 0),
      0.001,
    )
    const input = doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, duration]))
      .setBuffer(buffer)
    for (const node of nodes) {
      for (const path of ['translation', 'rotation', 'scale'] as const) {
        if (
          animation
            .listChannels()
            .some((channel) => channel.getTargetNode() === node && channel.getTargetPath() === path)
        ) {
          continue
        }
        const value = restTransform(node, path)
        const output = doc
          .createAccessor()
          .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
          .setArray(new Float32Array([...value, ...value]))
          .setBuffer(buffer)
        const sampler = doc
          .createAnimationSampler()
          .setInput(input)
          .setOutput(output)
          .setInterpolation('LINEAR')
        animation.addSampler(sampler)
        animation.addChannel(
          doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler),
        )
      }
    }
  }
}

function restTransform(node: Node, path: 'translation' | 'rotation' | 'scale'): number[] {
  if (path === 'translation') {
    return node.getTranslation()
  }
  if (path === 'rotation') {
    return node.getRotation()
  }
  return node.getScale()
}
