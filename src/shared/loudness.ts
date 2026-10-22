/** EBU R128 / ITU-R BS.1770 playback target. */
export const LOUDNESS_TARGET_LUFS = -14

/** The loudness fields googlevideo exposes on adaptive audio formats. */
type LoudnessMetadata = {
  loudnessDb?: unknown
  perceptualLoudnessDb?: unknown
  trackAbsoluteLoudnessLkfs?: unknown
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Reads a stream's integrated loudness in LKFS (numerically LUFS), measured by
 * YouTube with ITU-R BS.1770. `loudnessDb` is relative to the -14 LUFS target,
 * so a -10.86 LUFS stream is reported as +3.14 dB.
 */
export function integratedLoudness(format: LoudnessMetadata): number | null {
  const absolute = finite(format.trackAbsoluteLoudnessLkfs)
  if (absolute !== null && absolute >= -70 && absolute <= 0) return absolute
  const perceptual = finite(format.perceptualLoudnessDb)
  if (perceptual !== null && perceptual >= -70 && perceptual <= 0) return perceptual
  const relative = finite(format.loudnessDb)
  if (relative === null) return null
  const derived = LOUDNESS_TARGET_LUFS + relative
  return derived >= -70 && derived <= 0 ? derived : null
}

/** Gain in dB that moves an integrated loudness reading to -14 LUFS. */
export function normalizationGainDb(lufs: number | null): number {
  if (lufs === null || !Number.isFinite(lufs)) return 0
  return LOUDNESS_TARGET_LUFS - lufs
}

/** Linear gain equivalent of {@link normalizationGainDb}. */
export function normalizationGain(lufs: number | null): number {
  return 10 ** (normalizationGainDb(lufs) / 20)
}
