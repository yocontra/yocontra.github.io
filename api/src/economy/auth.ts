/** Stream C's routes import auth through this module; it is stream A's real implementation. */
// biome-ignore lint/performance/noBarrelFile: a deliberate single re-export so C's imports stay stable
export { authenticate, type Player } from '../auth/session.ts'
