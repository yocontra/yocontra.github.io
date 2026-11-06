/** Types shared by the bridge's two sides, so `native.ts` and `bridge.ts` can stay typed and acyclic. */

export type HapticKind = 'shot' | 'hit' | 'beat'
export type SignInPurpose = 'login' | 'register' | 'reauth'

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface SharePayload {
  title: string
  url: string
  image?: string
}

/** Messages the native shell pushes into the page. */
export interface BridgeEvents {
  pause: undefined
  resume: undefined
  safeArea: Insets
}

/** Messages the page sends to the native shell. */
export interface BridgeCommands {
  haptic: { kind: HapticKind }
  'tokens.access': undefined
  share: SharePayload
  signIn: { purpose: SignInPurpose }
}
