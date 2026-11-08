/** Public Frontier mount: both practice and online play use the native engine. */
import type { AudioEngine } from '../../audio/audio.ts'
import { mountNativeFrontier } from '../../client/frontier.ts'

export type FrontierExit = 'left' | 'quit' | 'lost' | 'refused'

export interface FrontierOptions {
  /** 'remote' joins the real lobby (default); 'loopback' runs the in-browser practice town. */
  server?: 'remote' | 'loopback'
  /** API base for `/town/join` (defaults to `PUBLIC_API_URL`). */
  apiUrl?: string
  /** Ask for a specific lobby ("Ride to a busier town", rejoin). */
  lobbyId?: string
  /** Server bots (dev only) or loopback bots (default 15). */
  bots?: number
  /** Loopback only: simulated one-way latency and jitter, ms. */
  lagMs?: number
  jitterMs?: number
  /** Loopback only: your name. */
  name?: string
  /** Loopback only (perf harness): the bots crowd around you and leave you be. */
  cluster?: boolean
  /** Loopback only (perf harness): the lobby's RNG seed, for repeatable runs. */
  seed?: number
  /** Loopback only (perf harness): where you first appear, layout metres. */
  spawn?: { x: number; z: number }
  /** Access token source for `/town/join` (defaults to the passkey session). */
  getToken?: () => Promise<string | null>
  /** Share the hub's audio engine (one AudioContext per page). */
  audio?: AudioEngine
  onExit?: (reason: FrontierExit, detail?: string) => void
}

export interface FrontierHandle {
  /** Resolves once the town is on screen. */
  readonly ready: Promise<void>
  leave: () => void
  destroy: () => void
  /** Perf and net numbers (also on `globalThis.__frontier` in dev builds). */
  debug: () => Record<string, unknown>
}

export function mountFrontier(root: HTMLElement, opts: FrontierOptions = {}): FrontierHandle {
  return mountNativeFrontier(root, opts)
}
