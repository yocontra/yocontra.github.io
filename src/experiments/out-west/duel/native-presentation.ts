import { Vec3 } from 'playcanvas'
import { ASSETS } from '../content/manifest.ts'
import { FEEL } from '../data/feel.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { say } from './chatter.ts'
import { dueShot } from './judge.ts'
import { DuelActor } from './native-actor.ts'
import type { NativeDirector } from './native-director.ts'

export function hubShot(d: NativeDirector, shot: string): void {
  d.game.app.scene.exposure = 1.1
  void d.arenas.show('street').then(() => d.atmosphere.arrange(d.arenas.life))
  if (d.player) {
    d.player.root.enabled = true
  }
  d.player?.place(2.4, 0, 7.5)
  d.player?.face(shot === 'store' ? 25 : -20)
  d.player?.play('Idle')
  d.game.camera.setPosition(4.5, 1.9, shot === 'store' ? 11 : 12)
  d.game.camera.lookAt(new Vec3(1.7, 1, 7.5))
}

function camera(d: NativeDirector): void {
  if (d.phase === 'title' || d.phase === 'end') {
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
  if (animation?.activeState === 'HitRecieve' && animation.activeStateProgress >= 0.98) {
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
  d.c.audio.play('fire', { gain: 0.7 })
  if (shot.hit) {
    d.resolve('loss', d.reactionMs)
  }
}
export function update(d: NativeDirector, dt: number): void {
  const now = performance.now()
  d.atmosphere.update()
  d.c.hud.update(dt * 1000)
  d.c.audio.update()
  const position = d.game.camera.getPosition()
  const forward = d.game.camera.forward
  d.c.audio.setListener(position.x, position.y, position.z, forward.x, forward.y, forward.z)
  if (d.ranked || !d.paused) {
    d.clock.tick(now)
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
      if (d.phaseT >= FEEL.resultAt + FEEL.resultFor) {
        d.advance()
      }
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
