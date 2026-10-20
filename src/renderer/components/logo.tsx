type Props = { className?: string }

/** Minimal Muzeec mark: an "M" drawn as a single waveform line. */
export function Logo({ className }: Props) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={className}>
      <path
        d="M14 46V22c0-2.2 2.6-3.3 4.2-1.8L32 34l13.8-13.8c1.6-1.5 4.2-.4 4.2 1.8v24"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
