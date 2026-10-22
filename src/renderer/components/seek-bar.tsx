import { useRef } from "react"
import { cn } from "cn"
import { formatTime } from "@/lib/media"

/** Seconds moved by the arrow keys while the bar has focus. */
const KEYBOARD_STEP = 5

type SeekBarProps = {
  /** Current playhead in seconds (or the scrub preview while dragging). */
  value: number
  /** Track duration in seconds. */
  max: number
  disabled?: boolean
  onScrub: (seconds: number) => void
  onCommit: (seconds: number) => void
  onCancel: () => void
  className?: string
}

/**
 * A click-anywhere seek bar. Pressing or dragging across the whole hit area
 * previews the position and seeks on release, instead of requiring the thumb
 * to be dragged from its current position.
 */
export function SeekBar({ value, max, disabled = false, onScrub, onCommit, onCancel, className }: SeekBarProps) {
  const bar = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const scale = Number.isFinite(max) && max > 0 ? max : 0
  const position = scale > 0 && Number.isFinite(value) ? Math.min(Math.max(0, value), scale) : 0
  const percent = scale > 0 ? (position / scale) * 100 : 0

  const secondsAt = (clientX: number): number => {
    const rect = bar.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * scale
  }

  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(scale)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={formatTime(position)}
      aria-disabled={disabled || undefined}
      className={cn(
        "group relative flex h-4 w-full touch-none items-center rounded-full outline-none select-none",
        disabled ? "cursor-default opacity-50" : "cursor-pointer",
        className,
      )}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        onScrub(secondsAt(event.clientX))
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return
        onScrub(secondsAt(event.clientX))
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return
        dragging.current = false
        onCommit(secondsAt(event.clientX))
      }}
      onPointerCancel={() => {
        if (!dragging.current) return
        dragging.current = false
        onCancel()
      }}
      onLostPointerCapture={() => {
        if (!dragging.current) return
        dragging.current = false
        onCancel()
      }}
      onKeyDown={(event) => {
        if (disabled) return
        let next: number | null = null
        if (event.key === "ArrowLeft") next = position - KEYBOARD_STEP
        else if (event.key === "ArrowRight") next = position + KEYBOARD_STEP
        else if (event.key === "Home") next = 0
        else if (event.key === "End") next = scale
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        onCommit(Math.min(Math.max(0, next), scale))
      }}
    >
      <div className="h-2 w-full overflow-hidden rounded-full bg-input/90">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 h-4 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md ring-1 ring-black/10",
          !disabled &&
            "transition-[box-shadow] group-hover:ring-4 group-hover:ring-ring/30 group-focus-visible:ring-4 group-focus-visible:ring-ring/30",
        )}
        style={{ left: `clamp(12px, ${percent}%, calc(100% - 12px))` }}
      />
    </div>
  )
}
