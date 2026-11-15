/** Coherent recorded performances: revolver reports and one pair of cowboy boots, no synthetic layers. */
import { credit, FREESOUND as FS } from './cc0.ts'
import { fade, load, mixInto, slice } from './dsp.ts'
import { cut, gridOf, norm } from './frontier-grid.ts'
import type { Recipe } from './recipes.ts'

/** Five reports from one .38 revolver; their natural sharp attack keeps the weapon identifiable. */
const SHOTS = [0.21, 2.05, 4.01, 5.87, 6.81]
const BODY_SHOTS = [0.14, 2.51, 4.4, 6.43, 8.53]
/** Small projectiles striking timber, with no heavy object-drop layers. */
const TIMBER = [FS.timber319223, FS.timber319226, FS.timber319227, FS.timber319228]
/** Ten clean heel/toe steps from the same boots/plank/microphone performance. */
const STEPS = [3.05, 3.74, 5.76, 9.95, 10.86, 11.63, 13.2, 16.7, 18.26, 33.32]

export const RECORDED_FRONTIER: Record<string, Recipe> = {
  hit_timber_recorded: {
    out: 'sfx/hit_timber_recorded.m4a',
    lufs: -23,
    maxGR: 1,
    credit: credit(...TIMBER),
    make: () =>
      gridOf(
        'hit_timber_recorded',
        TIMBER.map((source) => cut(load(source.file, 1, 'highpass=f=160'), 0.22)),
      ),
  },
  shots_revolver_recorded: {
    out: 'sfx/shots_revolver_recorded.m4a',
    lufs: -15,
    maxGR: 1.5,
    credit: credit(FS.revolver38Session, FS.magnumExterior),
    make: () => {
      const source = load(FS.revolver38Session.file, 1, 'highpass=f=35')
      // A second recorded revolver supplies the close microphone's body below the sharp report.
      // Keep it short and band-limited: this is a pressure pulse, not another reverberant shot.
      const body = load(FS.magnumExterior.file, 1, 'highpass=f=65,lowpass=f=900')
      return gridOf(
        'shots_revolver_recorded',
        SHOTS.map((at, i) =>
          mixInto(
            norm(cut(source, 0.22, -30, at), -1),
            norm(cut(body, 0.17, -30, BODY_SHOTS[i] ?? 0), -1),
            0.002,
            -8,
          ),
        ),
        'rms',
      )
    },
  },
  tails_revolver_recorded: {
    out: 'sfx/tails_revolver_recorded.m4a',
    lufs: -24,
    maxGR: 1,
    credit: credit(FS.revolver38Session),
    make: () => {
      const source = load(FS.revolver38Session.file, 1, 'highpass=f=140,lowpass=f=6500')
      // Keep only the late air decay, after the close report and before the next shot.
      return gridOf(
        'tails_revolver_recorded',
        SHOTS.map((at) => fade(slice(source, at + 0.16, at + 0.76), 0.035, 0.3)),
      )
    },
  },
  steps_cowboy_boards: {
    out: 'sfx/steps_cowboy_boards.m4a',
    lufs: -21,
    maxGR: 1.5,
    credit: credit(FS.cowboyBoards),
    make: () => {
      const source = load(FS.cowboyBoards.file, 1, 'highpass=f=65')
      return gridOf(
        'steps_cowboy_boards',
        STEPS.map((at) => cut(source, 0.34, -30, at)),
      )
    },
  },
}
