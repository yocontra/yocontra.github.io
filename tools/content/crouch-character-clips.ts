/** Author finite crouched upper-body clips against the native crouch hip frame. */
import type { Animation, Document } from '@gltf-transform/core'
import { Quat } from 'playcanvas'

function rotation(clip: Animation, bone: string): Quat {
  const channel = clip
    .listChannels()
    .find(
      (entry) => entry.getTargetNode()?.getName() === bone && entry.getTargetPath() === 'rotation',
    )
  const values = channel
    ?.getSampler()
    ?.getOutput()
    ?.getElement(0, [] as number[])
  if (values?.length !== 4) {
    throw new Error(`Missing authored ${bone} rotation in ${clip.getName()}`)
  }
  return new Quat(values[0], values[1], values[2], values[3])
}

export function appendCrouchClips(doc: Document): void {
  const clips = new Map(
    doc
      .getRoot()
      .listAnimations()
      .map((clip) => [clip.getName(), clip]),
  )
  const crouch = clips.get('Crouch_Idle')
  if (!crouch) {
    throw new Error('Missing native crouch stance')
  }
  const parent = rotation(crouch, 'Hips').invert()
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  for (const name of [
    'Idle_Gun_Pointing',
    'Gun_Shoot',
    'Reload',
    'Hold_rifle',
    'Hold_shotgun',
    'Shoot_rifle',
    'Shoot_shotgun',
    'Aim_Up',
    'Aim_Down',
  ]) {
    const source = clips.get(name)
    if (!source) {
      throw new Error(`Missing native weapon pose ${name}`)
    }
    const compensation = new Quat().mul2(parent, rotation(source, 'Hips'))
    const clip = doc.createAnimation(`Crouch_${name}`)
    for (const channel of source.listChannels()) {
      const old = channel.getSampler()
      const input = old?.getInput()
      const output = old?.getOutput()
      const node = channel.getTargetNode()
      const path = channel.getTargetPath()
      if (!(old && input && output && node && path)) {
        throw new Error(`Incomplete authored ${name} channel`)
      }
      let values = output
      if (node.getName() === 'Abdomen' && path === 'rotation') {
        const data = new Float32Array(output.getCount() * 4)
        for (let i = 0; i < output.getCount(); i++) {
          const q = output.getElement(i, [] as number[])
          const result = new Quat().mul2(compensation, new Quat(q[0], q[1], q[2], q[3])).normalize()
          data.set([result.x, result.y, result.z, result.w], i * 4)
        }
        values = doc.createAccessor().setType('VEC4').setArray(data).setBuffer(buffer)
      }
      const sampler = doc
        .createAnimationSampler()
        .setInput(input)
        .setOutput(values)
        .setInterpolation(old.getInterpolation())
      clip
        .addSampler(sampler)
        .addChannel(
          doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler),
        )
    }
  }
}
