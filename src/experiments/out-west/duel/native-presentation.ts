import { BoundingBox, Entity, Vec2, Vec3 } from 'playcanvas'
import { ASSETS } from '../content/manifest.ts'
import { FEEL } from '../data/feel.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { say } from './chatter.ts'
import { dueShot } from './judge.ts'
import { DuelActor } from './native-actor.ts'
import type { NativeDirector } from './native-director.ts'
import { plannedShot } from './native-shot.ts'

const hubViews = new WeakMap<NativeDirector, { shot: string; layout: string }>()

function gunBounds(actor: DuelActor): BoundingBox | null {
  const bounds = new BoundingBox()
  let found = false
  for (const mount of actor.weaponMounts) {
    if (!mount.drawn) {
      continue
    }
    for (const node of mount.node.find(
      (candidate) => candidate instanceof Entity && Boolean(candidate.render),
    )) {
      if (!(node instanceof Entity && node.render)) {
        continue
      }
      for (const mesh of node.render.meshInstances) {
        if (found) {
          bounds.add(mesh.aabb)
        } else {
          bounds.copy(mesh.aabb)
          found = true
        }
      }
    }
  }
  return found ? bounds : null
}

function hubFocus(d: NativeDirector, shot: string, root: HTMLElement | null) {
  const guns =
    shot === 'store' &&
    root?.querySelector('.ow-store-tab[aria-selected="true"]')?.textContent?.trim() === 'Guns'
  d.player?.play(guns ? 'Idle_Gun_Pointing' : 'Idle')
  const center = new Vec3(2.4, 1.04, 7.5)
  const bounds = guns && d.player ? gunBounds(d.player) : null
  if (bounds) {
    const extent = Math.max(bounds.halfExtents.x, bounds.halfExtents.y, bounds.halfExtents.z) * 2
    return {
      center: bounds.center,
      height: Math.max(0.7, extent * 1.2),
      width: Math.max(0.85, extent * 1.3),
      side: 0.92,
      forward: 0.4,
      guns: true,
    }
  }
  return { center, height: 2.25, width: 1.15, side: 0.22, forward: 0.975, guns: false }
}

/** Use the engine's shift lens to fit the rider in the space the responsive panels leave. */
function frameHub(d: NativeDirector): void {
  const view = hubViews.get(d)
  const lens = d.game.camera.camera
  if (!(view && lens)) {
    return
  }
  const canvas = d.game.app.graphicsDevice.canvas
  if (!(canvas instanceof HTMLCanvasElement)) {
    return
  }
  const bounds = canvas.getBoundingClientRect()
  const root = canvas.parentElement
  const portrait = bounds.height > bounds.width
  const panel = root?.querySelector(view.shot === 'store' ? '.ow-store' : '.ow-hub-side')
  const rect = panel?.getBoundingClientRect()
  const strip = root?.querySelector('.ow-hub-top')?.getBoundingClientRect()
  let top = 16
  let bottom = bounds.height - 16
  let right = bounds.width - 20
  const left = 20
  if (rect) {
    if (portrait) {
      bottom = rect.top - bounds.top - 16
      if (view.shot !== 'store' && strip) {
        top = strip.bottom - bounds.top + 16
      }
    } else {
      right = rect.left - bounds.left - 20
      if (view.shot !== 'store' && strip) {
        top = strip.bottom - bounds.top + 12
      }
    }
  }
  const focus = hubFocus(d, view.shot, root)
  const width = Math.max(100, right - left)
  const height = Math.max(90, bottom - top)
  const layout = [bounds.width, bounds.height, left, top, width, height, Number(focus.guns)]
    .map(Math.round)
    .join(',')
  if (layout === view.layout && !focus.guns) {
    return
  }
  view.layout = layout
  lens.fov = view.shot === 'store' ? 35 : 42
  const scale = bounds.height / (2 * Math.tan((lens.fov * Math.PI) / 360))
  const distance = Math.max((focus.height * scale) / height, (focus.width * scale) / width) * 1.08
  const centerX = left + width / 2
  const centerY = top + height / 2
  lens.projectionOffset = new Vec2(
    1 - (2 * centerX) / bounds.width,
    (2 * centerY) / bounds.height - 1,
  )
  d.game.camera.setPosition(
    focus.center.x + distance * focus.side,
    focus.center.y + distance * 0.04,
    focus.center.z + distance * focus.forward,
  )
  d.game.camera.lookAt(focus.center)
}

export function hubShot(d: NativeDirector, shot: string): void {
  d.debris.reset()
  d.game.app.scene.exposure = 1.1
  void d.arenas.show('street').then(() => d.atmosphere.arrange(d.arenas.life))
  if (d.player) {
    d.player.root.enabled = true
  }
  d.player?.place(2.4, 0, 7.5)
  d.player?.face(shot === 'store' ? 25 : -20)
  d.player?.play('Idle')
  hubViews.set(d, { shot, layout: '' })
  frameHub(d)
}

function camera(d: NativeDirector): void {
  if (d.phase === 'title') {
    frameHub(d)
    return
  }
  if (d.phase === 'end') {
    return
  }
  const distance = Math.max(4, d.walked * 0.7)
  const side = d.game.app.graphicsDevice.width < d.game.app.graphicsDevice.height ? 2.7 : 4.4
  d.game.camera.setPosition(side, 2, -distance - 5)
  d.game.camera.lookAt(new Vec3(0, 1.1, Math.min(2, distance * 0.3)))
  if (d.game.camera.camera) {
    d.game.camera.camera.fov = d.phase === 'call' ? FEEL.fovCall : 42
  }
}
function walk(d: NativeDirector, dt: number): void {
  if (d.walkLines === 0 && d.outlaw.lines[0]) {
    say(d, d.outlaw.name, d.outlaw.lines[0])
    d.walkLines++
  }
  const oldPace = Math.floor(d.walked)
  if (d.c.input.walking) {
    d.walked += dt / FEEL.paceSeconds
    d.stalled = 0
  } else {
    d.stalled += dt
  }
  const distance = Math.min(d.walked, d.targetPaces) * 0.7
  d.player?.place(0, 0, -0.4 - distance)
  d.enemy?.place(0, 0, 0.4 + distance)
  d.player?.play(d.c.input.walking ? 'Walk' : 'Idle_Gun')
  d.enemy?.play(d.c.input.walking ? 'Walk' : 'Idle_Gun')
  d.c.hud.setPips(Math.floor(d.walked), true)
  if (Math.floor(d.walked) > oldPace) {
    d.c.audio.play('dirtsteps', { gain: 0.6 })
    d.c.audio.play('spursteps', { gain: 0.3 })
  }
  if (d.walked >= d.targetPaces) {
    d.enter('turn')
    d.player?.play('Idle_Gun')
    d.enemy?.play('Idle_Gun')
  } else if (d.stalled >= FEEL.stallBackShot) {
    d.resolve('loss', null)
  }
}
function wait(d: NativeDirector, now: number): void {
  const animation = d.enemy?.model.anim?.baseLayer
  if (
    animation &&
    ['HitRecieve', 'Flinch'].includes(animation.activeState) &&
    animation.activeStateProgress >= 0.98
  ) {
    d.enemy?.play('Idle_Gun', 0.1)
  }
  const due = d.clock.callAt()
  if (
    !d.bellScheduled &&
    due !== null &&
    due - now <= Math.max(120, d.c.audio.outputLatencyMs + 50)
  ) {
    d.bellScheduled = true
    if (!d.dailyModifiers.includes('no-bell')) {
      d.c.audio.call(d.c.audio.perfToCtx(Math.max(due, now)))
    }
  }
  d.c.audio.heartbeat(Math.min(130, 70 + d.phaseT * 8))
}
function called(d: NativeDirector, now: number): void {
  if (!d.plan) {
    return
  }
  const shot = dueShot(d.plan, now, FEEL.tieMs, (who) =>
    who === 0 ? d.enemyAlive : d.riflemanAlive,
  )
  if (!shot) {
    return
  }
  shot.done = true
  plannedShot(d, shot)
  if (shot.hit) {
    d.resolve('loss', d.reactionMs)
  }
}
function won(d: NativeDirector, dt: number): void {
  if (d.phaseT >= 1.35 && d.phaseT - dt < 1.35) {
    d.player?.play('Spin', 0.08)
  }
  if (
    d.player?.model.anim?.baseLayer?.activeState === 'Spin' &&
    d.player.model.anim.baseLayer.activeStateProgress >= 0.98
  ) {
    d.player.play('Idle', 0.08)
  }
  if (d.phaseT >= FEEL.resultAt + FEEL.resultFor) {
    d.advance()
  }
}

export function update(d: NativeDirector, dt: number): void {
  const now = performance.now()
  const lens = d.game.camera.camera
  if (
    d.phase !== 'title' &&
    lens &&
    (lens.projectionOffset.x !== 0 || lens.projectionOffset.y !== 0)
  ) {
    lens.projectionOffset = Vec2.ZERO
  }
  d.atmosphere.update(dt, d.phase)
  d.c.hud.update(dt * 1000)
  d.c.audio.update()
  const position = d.game.camera.getPosition()
  const forward = d.game.camera.forward
  d.c.audio.setListener(position.x, position.y, position.z, forward.x, forward.y, forward.z)
  if (d.ranked || !d.paused) {
    d.clock.tick(now)
  }
  if (!d.paused) {
    d.debris.update(dt)
  }
  d.remote?.tick(now, dt)
  if (d.paused || d.interluding || d.remote) {
    return
  }
  d.phaseT += dt
  d.realTime += dt
  camera(d)
  switch (d.phase) {
    case 'intro':
      if (d.phaseT >= 2) {
        d.enter('poster')
      }
      break
    case 'poster':
      if (d.phaseT >= FEEL.posterDuration) {
        d.enter('cock')
        d.c.hud.hideCard()
      }
      break
    case 'cock':
      if (d.phaseT >= FEEL.inputEnableDelay && d.c.input.walking) {
        d.enter('walk')
      }
      break
    case 'walk':
      walk(d, dt)
      break
    case 'turn':
      if (d.phaseT >= FEEL.turnDuration) {
        d.wait()
      }
      break
    case 'wait':
      wait(d, now)
      break
    case 'call':
      called(d, now)
      break
    case 'bossWound':
      if (d.phaseT >= 1) {
        d.wait()
      }
      break
    case 'win':
      won(d, dt)
      break
    case 'lose':
    case 'coward':
      if (d.phaseT >= FEEL.loseAutoRetry) {
        d.retry()
      }
      break
    default:
      break
  }
}

export function remotePace(d: NativeDirector, paces: number): void {
  d.walked = paces
  d.player?.place(0, 0, -0.4 - paces * 0.7)
  d.enemy?.place(0, 0, 0.4 + paces * 0.7)
  d.player?.play('Walk')
  d.enemy?.play('Walk')
  d.c.hud.setPips(paces, true)
}

export async function lineup(d: NativeDirector, _day = 0.3): Promise<void> {
  d.enter('title')
  if (d.player) {
    d.player.root.enabled = false
  }
  const actors = await Promise.all(
    OUTLAWS.map((_outlaw, index) =>
      DuelActor.create(
        d.game,
        ASSETS[`outlaw-${index}` as keyof typeof ASSETS].url,
        `outlaw-${index}`,
      ),
    ),
  )
  for (const [index, actor] of actors.entries()) {
    actor.place((index - 8) * 1.6, 0, 0)
    actor.face(0)
  }
  d.game.camera.setPosition(0, 5, 25)
  d.game.camera.lookAt(new Vec3(0, 1, 0))
}

export function posters(d: NativeDirector): Promise<void> {
  return d.lineup()
}
