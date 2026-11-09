/** Native audio lifetime proof using a NullGraphicsDevice; no WebGL or renderer loop. */
import {
  AppBase,
  AppOptions,
  Asset,
  AudioListenerComponentSystem,
  Entity,
  NullGraphicsDevice,
  RenderComponentSystem,
  Sound,
  SoundComponentSystem,
  SoundManager,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { GameEffects } from '../../src/experiments/out-west/client/effects.ts'

interface AudioProbe {
  app: AppBase
  effects: GameEffects
  context: AudioContext
  baselineVoices: number
  shot: number
}
let probe: AudioProbe | undefined

export function audioSnapshot() {
  if (!probe) {
    throw new Error('Audio probe is not mounted')
  }
  const sounds = probe.app.root.findComponents('sound')
  return {
    state: probe.context.state,
    contextTime: probe.context.currentTime,
    manuallySuspended: probe.app.soundManager.suspended,
    components: sounds.length,
    voices: sounds.reduce(
      (sum, sound) =>
        sum + Object.values(sound.slots).reduce((count, slot) => count + slot.instances.length, 0),
      0,
    ),
    backend: probe.app.graphicsDevice.deviceType,
  }
}
function reportShots(count: number): void {
  if (!probe) {
    throw new Error('Audio probe is not mounted')
  }
  for (let index = 0; index < count; index++) {
    probe.effects.event({
      type: 'shot',
      shotId: ++probe.shot,
      spawnTick: 1,
      shooter: 0,
      aim: 0,
      range: 10,
      target: -1,
      flags: 0,
      x: 0,
      y: 16,
      z: 0,
      origin: { x: 0, y: 1.6, z: 0 },
      end: { x: 0, y: 1.6, z: -10 },
      pellets: [],
    })
  }
}
export async function beginAudioLifecycle() {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const device = new NullGraphicsDevice(canvas)
  const app = new AppBase(canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.soundManager = new SoundManager()
  options.componentSystems = [
    RenderComponentSystem,
    SoundComponentSystem,
    AudioListenerComponentSystem,
  ]
  app.init(options)
  const camera = new Entity('audio-camera', app)
  const stage = new Entity('audio-stage', app)
  app.root.addChild(camera)
  app.root.addChild(stage)
  const context = app.soundManager.context
  if (!context) {
    throw new Error('Web Audio is unavailable')
  }
  // Short silent native buffers prove source lifetime without a hundred-shot audible burst.
  const buffer = context.createBuffer(1, Math.round(context.sampleRate * 0.08), context.sampleRate)
  const assets = new Map<string, Asset>()
  const load = (url: string, texture: boolean): Promise<Asset> => {
    let asset = assets.get(url)
    if (!asset) {
      asset = new Asset(url, texture ? 'texture' : 'audio')
      asset.resource = texture
        ? new Texture(device, { width: 1, height: 1, mipmaps: false })
        : new Sound(buffer)
      asset.loaded = true
      app.assets.add(asset)
      assets.set(url, asset)
    }
    return Promise.resolve(asset)
  }
  const game = {
    app,
    camera,
    stage,
    loadAudio: (url: string) => load(url, false),
    loadTexture: (url: string) => load(url, true),
  } as GameApplication
  const effects = new GameEffects(game)
  await effects.ready
  await context.suspend()
  const baseline = new Entity('old-overlap-contract', app)
  stage.addChild(baseline)
  baseline.addComponent('sound', { positional: true })
  const asset = await load('baseline-report', false)
  const slot = baseline.sound?.addSlot('shot', { asset: asset.id, overlap: true })
  if (!slot) {
    throw new Error('Native baseline slot is missing')
  }
  for (let index = 0; index < 200; index++) {
    slot.play()
  }
  const baselineVoices = slot.instances.length
  slot.stop()
  baseline.destroy()
  probe = { app, effects, context, baselineVoices, shot: 0 }
  reportShots(100)
  return { baselineVoices, fixed: audioSnapshot() }
}
export function runningAudioShots() {
  reportShots(2)
  return audioSnapshot()
}
export async function manuallySuspendAudio() {
  if (!probe) {
    throw new Error('Audio probe is not mounted')
  }
  probe.app.soundManager.suspend()
  await probe.context.suspend()
  reportShots(100)
  return audioSnapshot()
}
export function explicitlyResumeAudio(): void {
  probe?.app.soundManager.resume()
}
export async function disposeAudioLifecycle() {
  if (!probe) {
    throw new Error('Audio probe is not mounted')
  }
  const { app, effects, context } = probe
  effects.destroy()
  app.destroy()
  if (context.state !== 'closed') {
    await context.close()
  }
  probe = undefined
  return { context: context.state, remainingSounds: app.root?.findComponents('sound').length ?? 0 }
}
