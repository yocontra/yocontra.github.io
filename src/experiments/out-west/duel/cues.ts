import { CylinderGeometry, Mesh, MeshStandardMaterial } from 'three'
import { makeCard } from '../scene/fx.ts'
import { between, type DuelState, rng, V } from './state.ts'

/**
 * Fake-outs and atmosphere during the wait. The same cue names come from the
 * ranked server and from the local practice clock, so both play identically.
 * Anything unknown plays as a generic creak.
 */

type CueFn = (s: DuelState) => void

const KICK_MS = 900

function caption(s: DuelState, text: string): void {
  s.c.hud.fake(text)
}

function creak(s: DuelState): void {
  const c = s.c
  caption(s, '[a saloon door creaks]')
  c.audio.play('door', { gain: 1, pos: V(11, 1.5, 2), reverb: 0.4 })
  for (const d of c.world.saloonDoors) {
    d.userData.kick = true
  }
  setTimeout(() => {
    for (const d of c.world.saloonDoors) {
      d.userData.kick = false
    }
  }, KICK_MS)
}

export function tossCoin(s: DuelState): void {
  const e = s.enemy
  if (!e || s.coin) {
    return
  }
  const coin = new Mesh(
    new CylinderGeometry(0.025, 0.025, 0.004, 14),
    new MeshStandardMaterial({ color: 0xd4_a6_40, metalness: 0.9, roughness: 0.3 }),
  )
  const p = e.root.position
  coin.position.set(p.x - 0.25, 1.2, p.z - 0.2)
  s.c.scene.add(coin)
  s.c.physics.add(coin, V(0, 3.1, -0.1), V(30, 0, 0), { rest: 0.1 })
  s.coin = coin
}

/** Throw one playing card into the wind (the card sharp). */
export function throwCard(s: DuelState): void {
  if (s.cards.length > 14) {
    return
  }
  const card = makeCard()
  const e = s.enemy
  card.position.set(between(-6, -3), between(0.5, 2), (e?.root.position.z ?? 0) + between(-4, 6))
  s.c.scene.add(card)
  s.c.physics.add(
    card,
    V(2, between(0, 1), between(-0.5, 0.5)),
    V(between(-8, 8), between(-8, 8), between(-8, 8)),
    { flutter: 3, ground: 0.01 },
  )
  s.cards.push(card)
}

export function clearCards(s: DuelState): void {
  for (const card of s.cards) {
    card.removeFromParent()
  }
  s.cards = []
  s.coin?.removeFromParent()
  s.coin = null
}

const heckle: CueFn = (s) => {
  caption(s, '[from the crowd] “DRR… rinks on me!”')
  s.c.audio.play('shout', { gain: 0.5, rate: 0.82, pos: V(-10, 1.6, 4), reverb: 0.4 })
}

const pianoStop: CueFn = (s) => {
  caption(s, '[the piano stops]')
  if (s.pianoVoice) {
    s.pianoVoice.stop()
    s.pianoVoice = null
  } else {
    s.c.audio.play('piano', { gain: 0.5, pos: V(11.5, 1.6, 2), offset: 6.1, duration: 0.5 })
  }
}

const distantShot: CueFn = (s) => {
  caption(s, '[a distant gunshot]')
  s.c.audio.play('fireBig', { gain: 0.35, pos: V(40, 3, -60), lowpass: 1400, reverb: 0.8 })
}

const twitch: CueFn = (s) => {
  caption(s, '[his hand twitches]')
  const e = s.enemy
  if (e) {
    e.twitch = 1
  }
  s.c.audio.play('holster', { gain: 0.25, pos: e?.root.position.clone() ?? V(), rate: 1.3 })
}

const CUES: Record<string, CueFn> = {
  tumbleweed: (s) => {
    caption(s, '[a tumbleweed rolls by]')
    const tw = s.c.tumbleweeds.find((t) => !t.active)
    const mid = s.enemy ? (s.player.root.position.z + s.enemy.root.position.z) / 2 : 0
    tw?.launch(mid + between(-1, 1), rng() < 0.5 ? 1 : -1, between(3.5, 5))
  },
  crow: (s) => {
    caption(s, '[a crow caws]')
    s.c.audio.play('crow', { gain: 0.9, pos: V(-12, 8, between(-10, 15)), reverb: 0.3 })
  },
  creak,
  door: creak,
  dog: (s) => {
    caption(s, '[a dog barks]')
    s.c.audio.play('dog', { gain: 0.8, pos: V(-30, 1, 30), reverb: 0.5 })
  },
  coin: (s) => {
    caption(s, '[a coin spins in the air]')
    tossCoin(s)
    s.c.audio.play('coin', {
      gain: 0.8,
      pos: s.enemy?.root.position.clone() ?? V(),
      reverb: 0.2,
      when: s.c.audio.now + 0.55,
    })
  },
  hiccup: (s) => {
    caption(s, '[hic!]')
    s.c.audio.play('shout', { gain: 0.3, rate: 1.6, pos: s.enemy?.root.position.clone() ?? V() })
    if (s.enemy) {
      s.enemy.twitch = 0.4
    }
  },
  bottle: (s) => {
    caption(s, '[a bottle smashes]')
    s.c.audio.play('bottle', { gain: 1, pos: V(-10, 1, between(-5, 10)), reverb: 0.4 })
  },
  gust: (s) => {
    caption(s, '[a gust of wind]')
    s.wind = Math.min(2.6, s.wind + 0.8)
    s.windLoop?.set(0.5, 0.2)
    s.c.puffs.emit(V(-4, 0.2, s.player.root.position.z + 3), 30, {
      speed: 2,
      size: 0.2,
      life: 1.6,
      alpha: 0.3,
      dir: V(3, 0, 0),
    })
  },
  whistle: (s) => {
    caption(s, '[his whistle stops dead]')
    s.c.audio.play('hawk', { gain: 0.25, rate: 1.25, pos: s.enemy?.root.position.clone() ?? V() })
  },
  'gang-drr': heckle,
  heckle,
  'piano-stop': pianoStop,
  piano: pianoStop,
  lantern: (s) => {
    caption(s, '[a lantern gutters]')
    s.c.audio.play('door', { gain: 0.25, rate: 1.4, pos: V(-8, 2.5, 0), reverb: 0.3 })
  },
  twitch,
  cards: (s) => {
    caption(s, '[cards scatter]')
    for (let i = 0; i < 5; i++) {
      throwCard(s)
    }
  },
  glint: (s) => {
    caption(s, '[a glint on the saloon roof]')
    const r = s.rifleman
    if (r) {
      s.c.glint.fire(r.headPos(V()).add(V(-0.35, -0.02, 0)))
    }
  },
  miscount: (s) => {
    s.c.hud.line(s.outlaw.name, '…TWELVE!', 1100)
    if (s.enemy) {
      s.enemy.twitch = 1
    }
  },
  'distant-shot': distantShot,
  gunshot: distantShot,
  horse: (s) => {
    caption(s, '[a horse whinnies]')
    s.c.audio.play('horse', { gain: 0.8, pos: V(14, 1.5, -46), reverb: 0.3 })
  },
}

/** Play a fake-out or atmosphere cue by name. */
export function playCue(s: DuelState, cue: string): void {
  const fn = CUES[cue] ?? creak
  fn(s)
}
