import { actSong, winStreak } from '../audio/catalog.ts'
import { FEEL } from '../data/feel.ts'
import { type Look, OUTLAWS, type Outlaw, RIFLEMAN_LOOK } from '../data/outlaws.ts'
import { interlude } from '../meta/events.ts'
import { save as persist } from '../save.ts'
import { castActor } from '../scene/cast.ts'
import { propObject } from '../scene/props.ts'
import { STREET } from '../scene/street.ts'
import { clearCards } from './cues.ts'
import type { Director } from './director.ts'
import { backToBackShot, otsShot, posterShot } from './framing.ts'
import { offerLicensedMode } from './licence-road.ts'
import { ambience } from './present.ts'
import { STEADY_MS } from './standoff.ts'
import { BACK_TO_BACK_Z, between, V } from './state.ts'

/**
 * Setting the stage for each outlaw: his models, the street, the poster, and
 * the cock of both guns before the walk. Also the retry after a loss.
 */

/** Every model file this outlaw (and his rifleman) needs. */
function looksFor(d: Director, o: Outlaw): Look[] {
  return o.gimmick === 'underboss' && d.c.rifle ? [o.look, RIFLEMAN_LOOK] : [o.look]
}

/** True when this outlaw's models are loaded; prefetches the next two either way. */
function prepare(d: Director, idx: number): boolean {
  const c = d.c
  const next = OUTLAWS[idx] as Outlaw
  if (!looksFor(d, next).every((l) => c.assets.lookLoaded(l))) {
    // Lazy-loaded per outlaw; normally prefetched a duel ahead so this is rare.
    c.hud.fake('[loading…]')
    return false
  }
  for (const k of [idx + 1, idx + 2]) {
    const n = OUTLAWS[k]
    for (const l of n ? looksFor(d, n) : []) {
      c.assets.lookReady(l).catch(() => undefined)
    }
  }
  return true
}

/** Music, fires, coffins and the clock for this outlaw. */
function setStage(d: Director): void {
  const c = d.c
  const under = d.underboss
  if (d.level >= 11) {
    c.audio.preloadSong('boss')
  }
  c.audio.playSong(actSong(d.level, d.outlaw.day, winStreak(d.level, c.save.attempts, c.save.best)))
  c.audio.loadVoice(d.outlaw.name)
  c.world.setFires(under)
  if (under) {
    d.fireLoop ??= c.audio.loop('fire_loop', 0.5)
  } else {
    d.fireLoop?.stop()
    d.fireLoop = null
  }
  // coffins outside the undertaker: one per man you've put down
  for (const im of c.coffins) {
    im.count = Math.min(im.instanceMatrix.count, 2 + d.level)
  }
  d.dayFrom = c.world.day
  d.dayTo = d.outlaw.day
  const day = d.outlaw.day
  const hour = day < 0.5 ? 12 + Math.round(day * 12) : Math.round(day * 12)
  c.world.setClock(d.boss ? 11 : hour, d.boss ? 59 : 0)
}

function resetPositions(d: Director): void {
  const p = d.player
  const e = d.enemy
  d.pDist = 0
  d.eDist = 0
  d.paces = 0
  d.speed = 0
  // the boss: face to face under the clock tower; everyone else back to back
  const [pz, ez, pr, er] = d.boss
    ? [44, 53, 0, Math.PI]
    : [-BACK_TO_BACK_Z, BACK_TO_BACK_Z, Math.PI, 0]
  p.root.position.set(0, 0, pz)
  p.root.rotation.set(0, pr, 0)
  e?.root.position.set(0, 0, ez)
  e?.root.rotation.set(0, er, 0)
  d.c.world.focusShadow(V(0, 0, d.boss ? 48 : 0))
}

function spawnRifleman(d: Director): void {
  const c = d.c
  if (!(d.underboss && c.rifle)) {
    return
  }
  const r = castActor(c.assets, {
    look: RIFLEMAN_LOOK,
    hat: 'cowboy',
    hatColor: 0x1a_14_10,
    bandana: 0x3a_2a_1a,
    rifle: c.rifle(),
  })
  r.root.position.copy(STREET.saloonRoof)
  r.root.rotation.y = Math.atan2(-STREET.saloonRoof.x, -5 - STREET.saloonRoof.z)
  c.scene.add(r.root)
  d.rifleman = r
  d.riflemanAlive = true
}

function spawnActors(d: Director): void {
  const c = d.c
  d.enemy?.dispose()
  d.rifleman?.dispose()
  d.rifleman = null
  const o = d.outlaw
  d.enemy = castActor(c.assets, {
    look: o.look,
    hat: o.hat,
    hatColor: o.hatColor,
    bandana: o.bandana,
    gun: c.gun ? propObject(c.gun) : null,
    offGun: o.gimmick === 'two-guns' || o.gimmick === 'boss',
  })
  c.scene.add(d.enemy.root)
  d.enemyAlive = true
  d.riflemanAlive = false
  spawnRifleman(d)
  const p = d.player
  p.root.visible = true
  p.stopAll()
  p.holsterGun()
  p.play('Idle', 0)
  resetPositions(d)
}

/** The poster beat that opens a new outlaw (not a retry). */
function showPoster(d: Director, idx: number): void {
  const c = d.c
  d.drawPosterTex(null)
  d.enter('poster')
  if (!c.save.seenPosters.includes(idx)) {
    c.save.seenPosters.push(idx)
  }
  persist(c.save)
  c.audio.musicLevel(0, 0.4)
  c.audio.musicLowpass(18_000, 0.3)
  c.hud.whipPan()
  c.audio.play('whip', { gain: 0.7 })
  if (c.save.legend && idx === 0) {
    c.hud.showCard({
      kind: 'info',
      title: 'LEGEND MODE',
      big: '2019',
      sub: 'The original 2019 timings.',
      hint: '',
    })
  }
  posterShot(d)
}

export function startLevel(d: Director, i: number, isRetry: boolean): void {
  const c = d.c
  const idx = Math.min(Math.max(0, i), OUTLAWS.length - 1)
  if (!prepare(d, idx)) {
    Promise.all(looksFor(d, OUTLAWS[idx] as Outlaw).map((l) => c.assets.lookReady(l))).then(
      () => startLevel(d, idx, isRetry),
      () => undefined,
    )
    return
  }
  d.level = idx
  d.outlaw = OUTLAWS[idx] as Outlaw
  c.save.level = idx
  persist(c.save)
  c.hud.setCounter(idx, OUTLAWS.length, c.save.legend)
  c.hud.hideCard()
  c.hud.clearCaptions()
  c.hud.clearCall()
  c.hud.irisRed(false)
  c.hud.letterbox(false)
  c.physics.clear()
  clearCards(d)
  d.timeScale = 1
  d.satTarget = 1
  d.bossPhase = 1
  d.midnightBells = 0
  d.callIsScream = false
  d.callPresentation = { bell: true, text: true }
  setStage(d)
  spawnActors(d)
  if (isRetry) {
    c.world.apply(d.dayTo)
    enterCock(d)
    return
  }
  showPoster(d, idx)
}

/** Clear the per-attempt state before a fresh walk. */
function resetAttempt(d: Director): void {
  d.stall = 0
  d.stallHeckled = false
  d.lastWalkTime = 0
  d.hatShot = false
  d.handShot = false
  d.lastReaction = null
  d.secondChance = false
  d.targetsDown = 0
  d.vignette = FEEL.vignetteBase
  d.satTarget = 1
}

/** Both men cock their guns; the walk (or the boss's clock) follows. */
export function enterCock(d: Director): void {
  const c = d.c
  const o = d.outlaw
  d.enter('cock')
  d.dying = null
  // one-shot cues in tickCock fire when phaseT crosses their delay, so start below all of them
  d.lastTick = 0
  d.standoffSent = false
  d.pianoVoice?.stop()
  d.pianoVoice = null
  c.save.attempts[d.level] = (c.save.attempts[d.level] ?? 0) + 1
  persist(c.save)
  resetPositions(d)
  d.player.root.visible = true
  d.player.holsterGun()
  d.player.play('Idle', 0.1)
  d.enemy?.holsterGun()
  d.enemy?.play('Idle', 0.1)
  if (d.enemy) {
    d.enemy.sway = o.gimmick === 'drunk' ? 1 : 0
    d.enemy.shake = o.gimmick === 'shaky' ? 0.6 : 0
  }
  resetAttempt(d)
  c.hud.hideCard()
  c.hud.setPips(0, false)
  c.input.resetToggle()
  c.audio.play('cocking', { gain: 0.9 })
  c.audio.musicLevel(0, 0.3)
  c.audio.musicLowpass(18_000, 0.3)
  ambience(d, 1, 0.6)
  const [lo, hi] = o.paces
  d.target = Math.max(lo, Math.min(hi, Math.round(between(lo, hi + 0.999) - 0.5)))
  clearCards(d)
  if (d.boss) {
    otsShot(d, false)
  } else {
    backToBackShot(d)
  }
}

/**
 * The boss's second phase restarts on its own after a loss. Ranked, after a
 * back-shot too: the server keeps him at phase two until he's dead.
 */
function retriesPhaseTwo(d: Director): boolean {
  if (!d.boss || d.bossPhase !== 2) {
    return false
  }
  return d.phase === 'lose' || (d.ranked && d.phase === 'coward')
}

function retryPhaseTwo(d: Director): void {
  const c = d.c
  d.player.root.visible = true
  d.player.holsterGun()
  d.player.play('Idle', 0.1)
  d.enemyAlive = true
  d.enemy?.play('Idle', 0.1)
  d.enemy?.holsterGun()
  c.save.attempts[d.level] = (c.save.attempts[d.level] ?? 0) + 1
  d.lastReaction = null
  d.secondChance = false
  d.hatShot = false
  d.handShot = false
  d.dying = null
  if (d.phase === 'coward') {
    // take the COWARD stamp off his poster
    d.drawPosterTex(null)
  }
  d.enterWait(false)
}

/** Try this outlaw again after a loss or a back-shot. */
export function retry(d: Director): void {
  const c = d.c
  // the press that retried (and a second tap right behind it) can't be a back-shot
  d.steadyUntil = performance.now() + STEADY_MS
  c.hud.hideCard()
  c.physics.clear()
  d.satTarget = 1
  d.timeScale = 1
  d.fallers = []
  if (retriesPhaseTwo(d)) {
    retryPhaseTwo(d)
    return
  }
  spawnActors(d)
  d.drawPosterTex(null)
  enterCock(d)
}

/**
 * A page from the meta-game (the Gazette) before something new; input is held until it's done.
 * Null when there is none, so the duel carries straight on.
 */
export function holdFor(d: Director, page: Promise<void> | null, then: () => void): void {
  if (!page) {
    then()
    return
  }
  d.interluding = true
  d.c.input.enabled = false
  page.then(
    () => {
      d.interluding = false
      d.c.input.enabled = true
      then()
    },
    () => undefined,
  )
}

export function nextLevel(d: Director): void {
  // the win's timer and a press both ask for the next outlaw; the Gazette may already be up
  if (d.interluding) {
    return
  }
  d.c.hud.hideCard()
  d.timeScale = 1
  if (d.level + 1 >= OUTLAWS.length) {
    d.toEnd()
    return
  }
  const next = d.level + 1
  d.c.save.level = next
  persist(d.c.save)
  // the licence road: a player who rode here from a licence gate is offered that mode first
  const offer = offerLicensedMode(d, next)
  const page = offer
    ? offer.then((left) => {
        if (left) {
          return
        }
        return interlude({ kind: 'next', level: next }) ?? undefined
      })
    : interlude({ kind: 'next', level: next })
  holdFor(d, page, () => {
    if (d.phase === 'win') {
      startLevel(d, next, false)
    }
  })
}
