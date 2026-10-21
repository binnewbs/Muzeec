/**
 * Crossfade progress as the incoming track plays: 0 at the hand-off,
 * 1 once the overlap window has fully elapsed.
 */
export function fadeGain(position: number, startPos: number, durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 1
  return Math.min(1, Math.max(0, (position - startPos) / durationSeconds))
}
