// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: slice times, not constants
/**
 * Takes kept from an earlier cast whose raw files are gone: `legacy/<id>.m4a` is that speaker's
 * shipped file as it was, and each line is the slice [at, len] in seconds (from the
 * `audio/voices.ts` written alongside it). `build-voices.ts` falls back to these when a line has
 * no raw take; they were mastered once already, so they are only levelled, not processed again.
 */
export const LEGACY: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> =
  {
    counter: {
      l0: [0, 0.855],
      l1: [0.975, 1.145],
      l2: [2.239, 1.44],
      l3: [3.799, 1.099],
      l4: [5.018, 1.667],
      l5: [6.805, 1.009],
      l6: [7.934, 2.154],
      l7: [10.209, 1.41],
      l8: [11.739, 1.414],
      death0: [13.273, 1.9],
      death1: [15.293, 2.692],
    },
    thornyrose: {
      l0: [0, 1.227],
      death0: [1.347, 2.041],
      death1: [3.508, 2.335],
    },
    boss: {
      x0: [0, 0.889],
      x1: [1.009, 3.252],
      death0: [4.381, 2.609],
      death1: [7.11, 3.476],
    },
    player: {
      e0: [0, 1.115],
      e1: [1.235, 0.697],
      e2: [2.052, 0.982],
      e3: [3.154, 0.559],
      e4: [3.834, 1.262],
      e5: [5.216, 2.201],
      e6: [7.536, 1.678],
      e7: [9.335, 2.255],
      e8: [11.71, 2.989],
      e9: [14.819, 3.185],
    },
  }
