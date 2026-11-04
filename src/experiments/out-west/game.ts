import { MeshStandardMaterial, Scene } from 'three'
import type { AudioEngine } from './audio/audio.ts'
import type { ItemId, Loadout } from './data/catalog.ts'
import type { Dyes } from './data/dye.ts'
import { OUTLAWS } from './data/outlaws.ts'
import { tickLife } from './duel/cues.ts'
import { Director, type RankedConnect } from './duel/director.ts'
import { PvpDuel, type PvpOpts } from './duel/pvp-duel.ts'
import { type Assets, loadAssets } from './engine/assets.ts'
import { Input } from './engine/input.ts'
import { Renderer, type Tier } from './engine/render.ts'
import { save as persist, resetRun, type SaveData } from './save.ts'
import { CameraRig } from './scene/camera.ts'
import { dressStreet } from './scene/dressing.ts'
import { Dust, Flash, Glint, Physics, Puffs, Tumbleweed, tumbleweedGeometry } from './scene/fx.ts'
import { type HubShot, hubShot, wearLoadout } from './scene/hub-stage.ts'
import { ItemStudio } from './scene/item-studio.ts'
import { propDef } from './scene/props.ts'
import { softDot } from './scene/textures.ts'
import { LIFE, TownLife } from './scene/townlife.ts'
import { World } from './scene/world.ts'
import { Hud } from './ui/hud.ts'
import type { GauntletChoice } from './ui/mode-select.ts'

export interface Game {
  begin: (skipIntro: boolean) => void
  readonly director: Director
  /** From the hub: a ranked or practice gauntlet, fresh or continued. */
  playGauntlet: (c: GauntletChoice) => void
  /** Frame your gunslinger for the hub or the Outfitter. */
  hubShot: (shot: HubShot) => void
  /** Dress your gunslinger in a loadout and its dye jobs (shows in single player too). */
  dress: (l: Loadout, dyes?: Dyes) => void
  /** A Bounty Hunt match, driven by the duel room. */
  startPvp: (o: PvpOpts) => void
  /** The Outfitter's picture of one piece of kit (rendered once, cached). */
  itemThumb: (id: ItemId) => HTMLCanvasElement | null
}

export interface GameOpts {
  root: HTMLElement
  canvas: HTMLCanvasElement
  audio: AudioEngine
  save: SaveData
  debug: boolean
  tier: Tier
  onProgress: (f: number) => void
  /** Opens a ranked session; null when this page load can't be ranked (debug hashes). */
  connectRanked: RankedConnect | null
  /** Pause → Saloon goes here (no hub on debug or level-jump loads). */
  onSaloon: (() => void) | null
}

/** Outfitter thumbnails, on the game's renderer; the studio is built on the first ask. */
function itemThumbs(renderer: Renderer, assets: Assets): (id: ItemId) => HTMLCanvasElement | null {
  let studio: ItemStudio | null = null
  return (id) => {
    studio ??= new ItemStudio(
      renderer.gl,
      assets.player,
      propDef(assets.props, 'revolver', 0.3, 'max'),
    )
    return studio.render(id)
  }
}

export async function createGame(o: GameOpts): Promise<Game> {
  const scene = new Scene()
  const rig = new CameraRig(window.innerWidth / window.innerHeight)
  const renderer = new Renderer(o.canvas, scene, rig.cam, o.tier)
  const aniso = Math.min(8, renderer.gl.capabilities.getMaxAnisotropy())
  const first = OUTLAWS[o.save.level] ?? OUTLAWS[0]
  const assets = await loadAssets(
    aniso,
    first
      ? first.look
      : { head: 'casual', body: 'casual', legs: 'casual', feet: 'casual', tint: {}, build: [1, 1] },
    (f) => o.onProgress(f * 0.85),
  )
  const world = new World(scene, assets.tex, renderer.spec.shadowSize, renderer.tier)
  const { coffins } = dressStreet(assets.props, world.root)

  const dot = softDot()
  const dust = new Dust(renderer.spec.dust, dot)
  scene.add(dust.points)
  const puffs = new Puffs(500, dot, false)
  scene.add(puffs.points)
  const sparks = new Puffs(200, dot, true)
  scene.add(sparks.points)
  const flash = new Flash()
  scene.add(flash.sprite)
  const glint = new Glint(dot)
  scene.add(glint.sprite)
  const physics = new Physics()
  const twGeo = tumbleweedGeometry()
  const twMat = new MeshStandardMaterial({ color: 0x8a_6a_42, roughness: 1 })
  const tumbleweeds = [0, 1, 2].map(() => {
    const t = new Tumbleweed(twGeo, twMat)
    scene.add(t.mesh)
    return t
  })

  const hud = new Hud(o.root)
  const input = new Input(o.canvas, o.save.settings.keys)
  const director = new Director({
    scene,
    world,
    rig,
    renderer,
    audio: o.audio,
    hud,
    input,
    assets,
    save: o.save,
    gun: propDef(assets.props, 'revolver', 0.3, 'max'),
    rifle: propDef(assets.props, 'rifle', 1.1, 'max'),
    coffins,
    dust,
    puffs,
    sparks,
    flash,
    glint,
    physics,
    tumbleweeds,
    debug: o.debug,
  })
  director.applySettings()
  director.connectRanked = o.connectRanked
  director.onSaloon = o.onSaloon
  world.silhouetteHide.push(dust.points, puffs.points, sparks.points, flash.sprite, glint.sprite)
  // town life: townsfolk, animals, crows, signs (kept off the red silhouette frame)
  const town = new TownLife(world.root, assets, renderer.tier, dot)
  LIFE.town = town
  world.silhouetteHide.push(town.root)

  // Compile every shader up front behind the title so the first shot never hitches.
  flash.sprite.visible = true
  glint.sprite.visible = true
  try {
    await renderer.gl.compileAsync(scene, rig.cam)
  } catch {
    // compileAsync unsupported: the warm-up render below still helps
  }
  rig.update(0.016, 0.016)
  renderer.render(0.016)
  renderer.renderSilhouette(world.silhouetteHide)
  flash.sprite.visible = false
  glint.sprite.visible = false
  o.onProgress(1)

  window.addEventListener('resize', () => renderer.resize())
  document.addEventListener('visibilitychange', () => {
    // Bounty Hunt has no pause: backgrounding is a drop, and the room's grace rules apply
    if (document.hidden && !director.hooks) {
      director.pauseIfPlaying()
    }
  })
  hud.pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (director.hooks) {
      // PvP: the pause button is "Flee"
      director.onPress({ action: 'pause', t: e.timeStamp, source: 'pointer', x: -1, y: -1 })
      return
    }
    director.togglePause()
  })
  hud.pauseBtn.addEventListener('pointerdown', (e) => e.stopPropagation())

  // ---------------------------------------------------------------- loop
  let last = performance.now()
  let fpsAcc = 0
  let fpsFrames = 0
  let fps = 60
  let frameMs = 16
  // The post passes would each reset renderer.info; count the whole frame instead.
  const info = renderer.gl.info
  info.autoReset = false
  let frameCalls = 0
  let frameTris = 0
  const loop = (now: number) => {
    requestAnimationFrame(loop)
    info.reset()
    const raw = now - last
    last = now
    const realDt = Math.min(0.05, Math.max(0, raw / 1000))
    fpsAcc += raw
    fpsFrames++
    if (fpsAcc > 500) {
      fps = (fpsFrames * 1000) / fpsAcc
      frameMs = fpsAcc / fpsFrames
      fpsAcc = 0
      fpsFrames = 0
    }
    const dt = director.frame(now, realDt)
    const phase = director.phase
    renderer.label = phase
    const tense = phase === 'wait' || phase === 'call' || phase === 'win' || phase === 'bossClock'
    if (!tense && renderer.adapt(raw, true)) {
      dust.points.visible = true
    }
    world.update(realDt)
    tickLife(director, dt, realDt)
    dust.update(realDt, renderer.dpr)
    puffs.update(dt, renderer.dpr, 0.6)
    sparks.update(dt, renderer.dpr, 0)
    flash.update(dt)
    glint.update(realDt)
    physics.update(dt, 1)
    for (const t of tumbleweeds) {
      t.update(dt, 0.6)
    }
    rig.update(realDt, realDt)
    const cam = rig.cam
    const fwd = cam.getWorldDirection(cam.position.clone())
    o.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z)
    o.audio.update()
    hud.update(raw)
    if (director.silhouetteFrames > 0) {
      director.silhouetteFrames--
      renderer.renderSilhouette(world.silhouetteHide)
    } else {
      renderer.render(realDt)
    }
    frameCalls = info.render.calls
    frameTris = info.render.triangles
    if (o.debug) {
      hud.setDebug(director.debugText({ fps, ms: frameMs, calls: frameCalls, tris: frameTris }))
    }
  }
  requestAnimationFrame(loop)

  return {
    director,
    // Ranked when this load allows it; begin() still keeps legend and mid-gauntlet saves in practice.
    begin: (skipIntro: boolean) => director.begin(skipIntro, o.connectRanked !== null),
    playGauntlet: (c: GauntletChoice) => {
      if (!c.resume) {
        resetRun(o.save, false)
        persist(o.save)
        hud.setPurse(0, false)
      }
      director.begin(c.resume || o.save.seenIntro, c.ranked && o.connectRanked !== null)
    },
    hubShot: (shot: HubShot) => hubShot(director, shot),
    dress: (l: Loadout, dyes?: Dyes) => wearLoadout(director, l, dyes),
    itemThumb: itemThumbs(renderer, assets),
    startPvp: (opts: PvpOpts) => {
      void new PvpDuel(director, opts)
    },
  }
}
