/**
 * The scene-side name for the shared building rules. The real table lives in `sim/building-rules.ts`
 * so the layout generator, the collision grid and the building audit use exactly the same
 * window/door geometry as the scene.
 */
export * from '../sim/building-rules.ts'
