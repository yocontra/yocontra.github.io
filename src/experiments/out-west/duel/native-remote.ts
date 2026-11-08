import { Vec3 } from 'playcanvas'
import type { Beat, DuelResult, RoomServerMessage, Seat } from '../contract/duel.ts'
import type { Press } from '../engine/input.ts'
import { DuelRoomLink } from '../net/pvp.ts'
import { DRAW_SOUNDS } from '../scene/draw-sounds.ts'
import { equippedActor } from '../scene/native-equipment.ts'
import { MatchIntro } from '../ui/match-intro.ts'
import { ResultsPanel, resultView } from '../ui/results.ts'
import { confirmSheet } from '../ui/sheet.ts'
import { LocalDuelClock } from './clock.ts'
import { watchRemoteAway } from './native-away.ts'
import type { NativeDirector } from './native-director.ts'
import { dropEnemyProps, duelShot } from './native-shot.ts'
import type { PvpOpts } from './options.ts'
import { RemoteDuelClock } from './remote.ts'

/** The existing authoritative duel service drives native engine presentation. */
export class NativeRemoteDuel {
  private readonly link: DuelRoomLink
  private readonly clock: RemoteDuelClock
  private seat: Seat = 0
  private intro: MatchIntro | null = null
  private results: ResultsPanel | null = null
  private beat: Beat = 'intro'
  private held = false
  private closed = false as boolean
  private lastPace = 0
  private result = null as DuelResult | null
  private serverOffset = 0
  private drawKnown = false as boolean
  private drawSound: keyof typeof DRAW_SOUNDS | undefined
  private rematch = -1
  private opponentEpoch = 0
  private fleeing = false as boolean
  private enemyShotDraw = -1
  private ownShotDraw = -1
  private readonly confirmation = new AbortController()
  private readonly unwatch: () => void
  private readonly director: NativeDirector
  private readonly opts: PvpOpts
  constructor(director: NativeDirector, opts: PvpOpts) {
    this.director = director
    this.opts = opts
    this.link = new DuelRoomLink(opts.wsUrl, {
      message: (message) => this.message(message),
      dropped: () => director.c.hud.fake('[Connection dropped · reconnecting]', 3000),
      rejoined: () => {
        this.held = !director.c.input.walking
      },
      gone: (reason) => {
        this.results?.closeRematch()
        director.c.hud.fake(reason, 4000)
        if (!this.result) {
          this.exit('saloon')
        }
      },
    })
    this.clock = new RemoteDuelClock(this.link)
    director.attachRemote(this, this.clock)
    director.c.hud.root.classList.add('ow-pvp')
    director.c.hud.setPurse(opts.purse ?? 0, false)
    this.unwatch = watchRemoteAway(director, this.link, () => !(this.closed || this.result))
  }
  tick(_now: number, _dt: number): void {
    if (this.closed) {
      return
    }
    const down = this.director.c.input.walking
    if (this.beat === 'walk' && this.held !== down) {
      this.held = down
      this.link.send({ type: 'hold', down })
    }
    const distance = Math.max(4, this.lastPace * 0.7)
    this.director.game.camera.setPosition(4, 2, -distance - 5)
    this.director.game.camera.lookAt(new Vec3(0, 1.1, 1))
  }
  press(press: Press): void {
    if (this.fleeing || this.closed) {
      return
    }
    if (this.beat === 'cock') {
      this.intro?.acknowledgeReady()
      this.link.send({ type: 'ready' })
      return
    }
    if (press.action !== 'fire') {
      return
    }
    if (this.beat === 'called') {
      if (this.director.shots === 0) {
        this.purchasedDrawReport()
      }
      this.ownShotDraw = this.clock.draw
      this.director.shoot(press)
    } else if (
      this.beat === 'wait' ||
      this.beat === 'turn' ||
      (this.beat === 'walk' && press.source === 'key')
    ) {
      this.clock.shot(0, null)
    }
  }
  private applyBeat(beat: Beat, deadline: number | null = null): void {
    this.beat = beat
    if (beat === 'intro') {
      this.director.enter('intro')
    } else if (beat === 'cock') {
      this.director.enter('cock')
      this.intro?.cock(deadline, this.serverOffset)
    } else if (beat === 'walk') {
      this.intro?.close()
      this.intro = null
      this.director.c.hud.hideCard()
      this.director.enter('walk')
    } else if (beat === 'turn') {
      this.director.enter('turn')
      this.director.player?.play('Idle_Gun')
      this.director.enemy?.play('Idle_Gun')
    } else if (beat === 'wait') {
      if (!this.drawKnown) {
        this.clock.draw++
      }
      this.drawKnown = false
      this.clock.dispose()
      this.director.wait()
    } else if (beat === 'called') {
      this.director.enter('call')
    } else if (beat === 'closed') {
      this.results?.closeRematch()
    }
  }
  private message(message: RoomServerMessage): void {
    const d = this.director
    switch (message.type) {
      case 'hello': {
        this.seat = message.you
        this.drawSound = message.posters[this.seat].loadout.drawSound
        this.serverOffset = message.serverTime - Date.now()
        if (message.rematch === this.rematch) {
          break
        }
        this.rematch = message.rematch
        this.enemyShotDraw = -1
        this.ownShotDraw = -1
        this.lastPace = 0
        this.result = null
        this.results?.root.remove()
        this.results = null
        this.intro?.close()
        this.intro =
          message.rematch === 0
            ? new MatchIntro(
                d.c.hud.root,
                message.posters[this.seat],
                message.posters[this.seat === 0 ? 1 : 0],
                {
                  ready: () => this.link.send({ type: 'ready' }),
                  flee: () => {
                    this.pause()
                  },
                },
              )
            : null
        if (message.rematch > 0) {
          this.link.send({ type: 'ready' })
        }
        void this.loadOpponent(message.posters[this.seat === 0 ? 1 : 0]).catch((error: unknown) =>
          d.c.hud.fake(error instanceof Error ? error.message : 'Could not load opponent.', 4000),
        )
        break
      }
      case 'sync':
        this.clock.draw = message.draw
        this.drawKnown = true
        this.lastPace = message.pace
        this.held = message.holding[this.seat]
        if (message.ready[this.seat]) {
          this.intro?.acknowledgeReady()
        }
        d.remotePace(message.pace)
        this.applyBeat(message.beat, message.deadline)
        this.drawKnown = false
        if (message.last) {
          this.showResult(message.last)
        }
        break
      case 'beat':
        this.applyBeat(message.beat, message.deadline)
        break
      case 'ready':
        if (message.seat === this.seat) {
          this.intro?.acknowledgeReady()
        } else {
          this.intro?.say('He’s ready.')
        }
        break
      case 'pace':
        this.lastPace = message.n
        d.remotePace(message.n)
        break
      case 'cue':
        this.clock.draw = message.draw
        d.duel = message.draw
        d.cue(message.cue)
        break
      case 'call':
        this.clock.draw = message.draw
        this.clock.call(message.draw, message.inMs, () => {
          this.beat = 'called'
          d.call()
        })
        break
      case 'result':
        this.showResult(message)
        break
      case 'deadHeat':
        this.opponentShot(true)
        this.historicalOwnShot()
        d.player?.play('Death', 0)
        d.enemy?.play('Death', 0)
        d.c.hud.fake('DEAD HEAT · sudden death', 2000)
        break
      case 'suddenDeath':
        this.clock.draw = message.draw
        this.drawKnown = true
        d.player?.play('Idle_Gun', 0)
        d.enemy?.play('Idle_Gun', 0)
        this.applyBeat('wait')
        break
      case 'heckle':
        d.c.hud.line(this.opts.opponent.name, 'Walk.')
        break
      case 'presence':
        if (!message.connected) {
          d.c.hud.fake('[Opponent reconnecting…]', 3000)
        }
        break
      case 'taunt':
        d.c.hud.line(this.opts.opponent.name, message.taunt.replaceAll('-', ' '))
        break
      case 'rematch':
        this.results?.setVotes(message.votes, this.seat, message.left)
        break
      case 'closed':
        this.results?.closeRematch()
        break
      case 'error':
        d.c.hud.fake(message.message, 3000)
        if (message.fatal) {
          this.exit('saloon')
        }
        break
      default:
        break
    }
  }
  private async loadOpponent(poster: PvpOpts['opponent']): Promise<void> {
    const d = this.director
    const epoch = ++this.opponentEpoch
    await d.startLevel(0)
    if (this.closed || epoch !== this.opponentEpoch) {
      return
    }
    const actor = await equippedActor(d.game, poster.loadout, poster.dyes)
    if (this.closed || epoch !== this.opponentEpoch) {
      actor.destroy()
      return
    }
    d.enemy?.destroy()
    d.enemy = actor
    actor.place(0, 0, 0.4 + this.lastPace * 0.7)
    actor.face(this.beat === 'called' ? 180 : 0)
    this.applyBeat(this.beat)
  }
  private purchasedDrawReport(): void {
    const sound = this.drawSound ? DRAW_SOUNDS[this.drawSound] : undefined
    if (!sound) {
      return
    }
    const audio = this.director.c.audio
    audio.play('fireBig', { gain: sound.gain, rate: sound.rate, reverb: 0.8 })
    if (sound.hawk) {
      audio.play('hawk', { gain: 0.5, when: audio.now + 0.35 })
    }
  }
  private opponentShot(hit: boolean): void {
    if (this.enemyShotDraw === this.clock.draw) {
      return
    }
    this.enemyShotDraw = this.clock.draw
    duelShot(this.director, this.director.enemy, hit ? this.director.player : null)
    this.director.c.audio.play('fireBig', {
      gain: 1.1,
      ...(this.director.enemy ? { pos: this.director.enemy.root.getPosition() } : {}),
    })
  }
  private historicalOwnShot(): void {
    if (this.ownShotDraw === this.clock.draw || this.director.shots > 0) {
      return
    }
    this.ownShotDraw = this.clock.draw
    duelShot(this.director, this.director.player, this.director.enemy)
    this.purchasedDrawReport()
    this.director.c.audio.play('fire', { gain: 0.8 })
  }
  private showResult(result: DuelResult): void {
    if (this.result?.draw === result.draw && (this.result.settled || !result.settled)) {
      return
    }
    this.results?.close()
    if (result.reactions[this.seat === 0 ? 1 : 0] !== null) {
      this.opponentShot(result.winner !== this.seat)
    }
    if (result.reactions[this.seat] !== null) {
      this.historicalOwnShot()
    }
    this.result = result
    this.beat = 'result'
    const win = result.winner === this.seat
    const even = result.winner === null && result.culprit === null
    const phase = even ? 'coward' : 'lose'
    this.director.enter(win ? 'win' : phase)
    if (win) {
      if (result.reactions[this.seat] !== null) {
        dropEnemyProps(this.director, this.director.enemy)
      }
      this.director.enemy?.play('Death', 0)
    } else {
      this.director.player?.play('Death', 0)
    }
    this.director.c.hud.hideCard()
    this.director.c.hud.clearCall()
    this.director.c.audio.heartbeat(0)
    this.results = new ResultsPanel(
      this.director.c.hud.root,
      {
        ...resultView(result, this.seat, this.opts.opponent.name, {
          before: result.you?.xpBefore ?? this.opts.xpBefore,
          after: result.you?.xpAfter ?? null,
        }),
        ...(result.settled
          ? {}
          : { pending: 'Settlement pending. Your account will update when it completes.' }),
      },
      {
        rematch: () => this.link.send({ type: 'rematch' }),
        next: () => this.exit('next'),
        saloon: () => this.exit('saloon'),
      },
      {
        name: this.opts.opponent.name,
        kind: this.opts.opponent.kind === 'human' ? 'human' : 'ghost',
        context: result.matchId,
      },
    )
    void this.opts
      .refreshXp()
      .then((xp) => {
        if (!this.closed && this.result === result) {
          this.results?.setXp(result.you?.xpBefore ?? this.opts.xpBefore, xp)
        }
      })
      .catch(() => {
        // The committed settlement already includes XP; a profile refresh is supplementary.
      })
  }
  pause(): void {
    if (this.closed || this.fleeing) {
      return
    }
    if (this.result) {
      this.exit('saloon')
      return
    }
    this.fleeing = true
    const before = this.beat === 'intro' || this.beat === 'cock'
    let body = 'Leaving now counts as a loss, with the full penalty.'
    if (before) {
      body =
        this.opts.opponent.kind === 'human'
          ? 'Leaving now is a dodge: half penalty and no XP.'
          : 'No penalty for leaving a ghost duel now.'
    }
    void confirmSheet(this.director.c.hud.root, {
      title: 'Leave the duel?',
      body,
      yes: 'Leave',
      no: 'Stay',
      danger: true,
      focusNo: true,
      signal: this.confirmation.signal,
    }).then((leave) => {
      this.fleeing = false
      if (!leave || this.closed) {
        return
      }
      this.link.send({ type: 'flee' })
      this.exit('saloon')
    })
  }
  private exit(how: 'saloon' | 'next'): void {
    this.close()
    this.director.saloon()
    this.opts.onExit(how)
  }
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.opponentEpoch++
    this.confirmation.abort()
    this.unwatch()
    this.director.c.hud.root.classList.remove('ow-pvp')
    this.link.close()
    this.clock.dispose()
    if (this.director.clock === this.clock) {
      this.director.clock = new LocalDuelClock(this.director.events)
    }
    this.intro?.close()
    this.results?.root.remove()
  }
}
