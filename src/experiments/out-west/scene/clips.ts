/** The character clips, by the game's names (player.glb; the move clips come from moves.glb). */
export type Clip =
  | 'Idle'
  | 'Idle_Neutral'
  | 'Idle_Gun'
  | 'Idle_Gun_Pointing'
  | 'Idle_Gun_Shoot'
  | 'Gun_Shoot'
  | 'Walk'
  | 'Run'
  | 'Death'
  | 'HitRecieve'
  | 'HitRecieve_2'
  | 'Wave'
  | MoveClip
/** Frontier only (ffa/scene/moves.ts): absent until loadMoves() appends them. */
type MoveClip =
  | 'Sprint'
  | 'Reload'
  | `Crouch_${'Idle' | 'Walk'}`
  | `Jump_${'Start' | 'Loop' | 'Land'}`
  | `Aim_${'Up' | 'Down'}`
