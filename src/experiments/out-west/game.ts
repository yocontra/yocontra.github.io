import type { AudioEngine } from './audio/audio.ts'
import { GameApplication } from './client/application.ts'
import { ASSETS } from './content/manifest.ts'
import type { ItemId, Loadout } from './data/catalog.ts'
import type { Dyes } from './data/dye.ts'
import { NativeDirector, type NativeRankedConnect } from './duel/native-director.ts'
import { NativeRemoteDuel } from './duel/native-remote.ts'
import type { DailyOpts, HubShot, PvpOpts } from './duel/options.ts'
import { RankedDuelClock } from './duel/ranked-clock.ts'
import { Input } from './engine/input.ts'
import { resetRun, type SaveData, save } from './save.ts'
import { Hud } from './ui/hud.ts'
import type { GauntletChoice } from './ui/mode-select.ts'

export interface Game {
  destroy: () => void
  begin: (skipIntro: boolean) => void
  whenWarm: () => Promise<void>
  readonly director: NativeDirector
  playGauntlet: (choice: GauntletChoice) => void
  hubShot: (shot: HubShot) => void
  dress: (loadout: Loadout, dyes?: Dyes) => void
  startPvp: (opts: PvpOpts) => void
  playDaily: (opts: DailyOpts) => void
  rankedRunId: () => string | null
  itemThumb: (id: ItemId) => HTMLCanvasElement | null
}
export interface GameOpts {
  root: HTMLElement
  canvas: HTMLCanvasElement
  audio: AudioEngine
  save: SaveData
  debug: boolean
  tier: 'low' | 'high'
  onProgress: (fraction: number) => void
  connectRanked: NativeRankedConnect | null
  onSaloon: (() => void) | null
}

/** One native engine application owns the hub, every solo duel and server-driven matches. */
export async function createGame(opts: GameOpts): Promise<Game> {
  const game = await GameApplication.create({
    canvas: opts.canvas,
    viewport: opts.root,
    pixelRatio: opts.tier === 'low' ? 1 : Math.min(devicePixelRatio, 1.5),
  })
  const lifecycle = new AbortController()
  let disposeDirector = (): void => undefined
  try {
    opts.onProgress(0.1)
    await game.instantiate(ASSETS.duel.url, 'duel-street')
    opts.onProgress(0.65)
    const hud = new Hud(opts.root)
    const input = new Input(opts.root, opts.save.settings.keys)
    const director = new NativeDirector(
      game,
      { save: opts.save, input, hud, audio: opts.audio },
      opts.connectRanked,
    )
    disposeDirector = () => director.dispose()
    director.onSaloon = opts.onSaloon
    await director.initialize()
    opts.onProgress(1)
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden && !director.ranked) {
          director.pauseIfPlaying()
        }
      },
      { signal: lifecycle.signal },
    )
    const begin = (skipIntro: boolean, ranked: boolean) => {
      void director
        .begin(skipIntro, ranked)
        .catch((error: unknown) =>
          hud.fake(error instanceof Error ? error.message : 'Could not start the duel.', 5000),
        )
    }
    let remoteDuel: NativeRemoteDuel | null = null
    return {
      destroy: () => {
        lifecycle.abort()
        disposeDirector()
        game.destroy()
      },
      director,
      whenWarm: () => Promise.resolve(),
      begin: (skipIntro) => begin(skipIntro, opts.connectRanked !== null),
      playGauntlet: (choice) => {
        if (!choice.resume) {
          resetRun(opts.save, false)
          save(opts.save)
        }
        begin(choice.resume || opts.save.seenIntro, choice.ranked && opts.connectRanked !== null)
      },
      hubShot: (shot) => director.hubShot(shot),
      dress: (loadout, dyes) => director.dress(loadout, dyes),
      startPvp: (pvp) => {
        remoteDuel?.close()
        remoteDuel = new NativeRemoteDuel(director, pvp)
      },
      playDaily: (daily) => {
        void director.dailyDuel(daily.spec, daily.session, daily.onExit)
      },
      rankedRunId: () =>
        director.clock instanceof RankedDuelClock ? director.clock.session.sessionId : null,
      // The store's existing content-addressed thumbnails are shared with account/profile UI.
      itemThumb: () => null,
    }
  } catch (error) {
    lifecycle.abort()
    disposeDirector()
    game.destroy()
    throw error
  }
}
