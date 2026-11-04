/** Feel tuning (design doc §3.1, §4.2). All times in seconds unless noted. */
export const FEEL = {
  posterDuration: 2.2,
  posterSlam: 0.25,
  enemyCockDelay: 0.6,
  inputEnableDelay: 0.9,
  paceSeconds: 0.5,
  walkRamp: 0.15,
  enemyStepOffset: 0.04,
  stallHeckle: 6,
  stallBackShot: 12,
  /** Settle after the last pace, backs still turned. */
  turnDuration: 0.6,
  /** Both spin to face each other on the bell. */
  callTurn: 0.3,
  musicFadeOut: 0.6,
  heartStartBpm: 70,
  heartBpmPerSecond: 8,
  heartMaxBpm: 130,
  fakeWindow: [0.35, 0.8] as const,
  maxFakes: 2,
  maxFakesBoss: 3,
  /** The call: an eased push from 32° to 28° (the doc's 250 ms dolly-zoom read as too violent). */
  callPushMs: 600,
  fovRest: 32,
  fovCall: 28,
  /** Walk and wait framings (landscape). */
  fovWalk: 34,
  fovWait: 30,
  /** DRAW! holds this long, then fades over 200 ms (CSS). */
  callHoldMs: 500,
  /** The [BELL TOLLS] caption clears this long after the call. */
  callCaptionMs: 1200,
  /** Music during the turn and wait: a gentle duck that stays clearly audible. */
  waitDuckDb: -7,
  /**
   * The tension bed's standoff duck. Its drones sit below the lowpass, so it ducks deeper to land
   * where the score has always sat under the bell (about -35 dB on the music bus).
   */
  tensionWaitDuckDb: -18,
  waitLowpass: 2800,
  tieMs: 8,
  secondShotMs: 300,
  delmerGapMs: 120,
  hitstopMs: 70,
  redFrames: 2,
  /** Kill cam: 90 ms at 1x so the hit lands, 0.25x for 0.9 s, then ease back over 0.3 s. */
  killCamLead: 0.09,
  killCamScale: 0.25,
  killCamSeconds: 0.9,
  killCamScaleReduced: 0.5,
  killCamSecondsReduced: 0.4,
  bossKillSeconds: 2.2,
  /**
   * The shot swing: the camera holds on the impact for `shotSwingHold` s, then swings around your
   * gun (past your gun hand, down the line of the shot) from the call framing onto the kill-cam
   * two-shot over `shotSwingSeconds` s (real time, so it rides through the slow-mo), eased in and
   * out: no cut, no roll.
   */
  shotSwingHold: 0.12,
  shotSwingSeconds: 1.0,
  /** The victim's death clip never runs slower than this, so the fall reads. */
  victimMinScale: 0.45,
  rampBack: 0.3,
  /** Coward back-shot: the kill-cam two-shot at 0.4x. */
  cowardScale: 0.4,
  cowardSlow: 0.8,
  cowardCardAt: 1.2,
  /** Result card waits for the kill cam to finish. */
  resultAt: 2.0,
  resultFor: 2.5,
  loseFall: 1.2,
  /** Your death: how long the eye-line takes to ease from the standoff framing into the fall, s. */
  loseBlend: 0.6,
  loseRetryPress: 0.6,
  loseAutoRetry: 2.5,
  cowardAutoRetry: 2.5,
  twoTargetGapMs: 100,
  shake: { own: 0.12, whizz: 0.08, hit: 0.3, decay: 1.5 },
  vignetteBase: 0.35,
  vignetteWait: 0.6,
  /** How long before the call the bell is scheduled on the audio clock, ms. */
  bellLookaheadMs: 120,
} as const
