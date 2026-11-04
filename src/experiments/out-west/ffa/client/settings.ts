/**
 * Frontier view and control settings, per device: the view mode (over the shoulder by default,
 * first person, or the original top-down camera), field of view, look sensitivity for mouse and
 * touch, invert-Y and the shoulder. Stored in localStorage (wrapped: private windows and blocked
 * storage just fall back to the defaults). `?view=top|first|third` overrides the mode for one
 * visit without saving it.
 *
 * Also the one-time onboarding flags ("seen how to play", the first-carry hint, and so on), so a
 * player sees each coach mark once per device.
 */

export type ViewMode = 'third' | 'first' | 'top'

export interface FrontierSettings {
  view: ViewMode
  /** Vertical field of view, degrees. */
  fovThird: number
  fovFirst: number
  /** Mouse-look multiplier (1 = 0.0022 rad per pixel). */
  mouseSens: number
  /** Touch-look multiplier (1 = 0.0055 rad per pixel). */
  touchSens: number
  /** Touch: look speed while the sights are up, as a share of `touchSens`. */
  touchAdsSens: number
  invertY: boolean
  /** 1 = right shoulder, −1 = left. */
  shoulder: 1 | -1
  /** Desktop: right click toggles the sights instead of holding them. */
  adsToggle: boolean
  /** Touch: the AIM button holds or toggles the sights. */
  adsMode: 'hold' | 'toggle'
  /** Touch: pushing the stick forward sprints without a separate button. */
  autoSprint: boolean
  /** Touch: fire whenever an enemy is under the crosshair (CoD Mobile's auto fire). */
  autoFire: boolean
  /** Empty the magazine, load it: no dead trigger. */
  autoReload: boolean
  /** Touch: mirror the thumb clusters (stick on the right). */
  leftHanded: boolean
  /** Touch: button size multiplier. */
  controlScale: number
  /** Touch: joystick size multiplier. */
  joyScale: number
}

export const FOV_RANGE = { min: 60, max: 95 } as const
export const SENS_RANGE = { min: 0.3, max: 3 } as const
export const ADS_SENS_RANGE = { min: 0.35, max: 1.25 } as const
export const CONTROL_RANGE = { min: 0.8, max: 1.35 } as const
export const JOY_RANGE = { min: 0.8, max: 1.4 } as const

export const DEFAULTS: FrontierSettings = {
  view: 'third',
  fovThird: 72,
  fovFirst: 80,
  mouseSens: 1,
  touchSens: 1,
  touchAdsSens: 0.8,
  invertY: false,
  shoulder: 1,
  adsToggle: false,
  adsMode: 'hold',
  autoSprint: true,
  autoFire: false,
  autoReload: true,
  leftHanded: false,
  controlScale: 1,
  joyScale: 1,
}

const KEY = 'ow.frontier.settings.v1'
const FLAGS_KEY = 'ow.frontier.coach.v1'

const VIEWS: readonly ViewMode[] = ['third', 'first', 'top']

const isView = (v: unknown): v is ViewMode => VIEWS.includes(v as ViewMode)

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

function read(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked or full: the setting lasts for this visit only.
  }
}

/** The saved settings, sanitised, with any `?view=` override applied (not saved). */
export function loadSettings(search = globalThis.location?.search ?? ''): FrontierSettings {
  const r = read(KEY)
  const s: FrontierSettings = {
    view: isView(r.view) ? r.view : DEFAULTS.view,
    fovThird: clamp(r.fovThird, FOV_RANGE.min, FOV_RANGE.max, DEFAULTS.fovThird),
    fovFirst: clamp(r.fovFirst, FOV_RANGE.min, FOV_RANGE.max, DEFAULTS.fovFirst),
    mouseSens: clamp(r.mouseSens, SENS_RANGE.min, SENS_RANGE.max, DEFAULTS.mouseSens),
    touchSens: clamp(r.touchSens, SENS_RANGE.min, SENS_RANGE.max, DEFAULTS.touchSens),
    touchAdsSens: clamp(
      r.touchAdsSens,
      ADS_SENS_RANGE.min,
      ADS_SENS_RANGE.max,
      DEFAULTS.touchAdsSens,
    ),
    invertY: r.invertY === true,
    shoulder: r.shoulder === -1 ? -1 : 1,
    adsToggle: r.adsToggle === true,
    adsMode: r.adsMode === 'toggle' ? 'toggle' : 'hold',
    autoSprint: r.autoSprint !== false,
    autoFire: r.autoFire === true,
    autoReload: r.autoReload !== false,
    leftHanded: r.leftHanded === true,
    controlScale: clamp(
      r.controlScale,
      CONTROL_RANGE.min,
      CONTROL_RANGE.max,
      DEFAULTS.controlScale,
    ),
    joyScale: clamp(r.joyScale, JOY_RANGE.min, JOY_RANGE.max, DEFAULTS.joyScale),
  }
  const q = new URLSearchParams(search).get('view')
  if (isView(q)) {
    s.view = q
  }
  return s
}

export function saveSettings(s: FrontierSettings): void {
  write(KEY, s)
}

export type CoachFlag = 'howto' | 'carry' | 'bankPrompt' | 'deathMoney' | 'banked'

/** One-time coach marks already shown on this device. */
export function coachSeen(flag: CoachFlag): boolean {
  return read(FLAGS_KEY)[flag] === true
}

export function markCoach(flag: CoachFlag): void {
  write(FLAGS_KEY, { ...read(FLAGS_KEY), [flag]: true })
}
