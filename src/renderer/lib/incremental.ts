import { useEffect, useRef, useState } from "react"

/**
 * Renders a window of a long list and grows it as the user scrolls.
 * Keeps thousands of queue rows from mounting at once without changing scroll behaviour.
 */
export function useIncrementalList(total: number, initial = 150, step = 150) {
  const [count, setCount] = useState(() => Math.min(total, initial))

  useEffect(() => {
    setCount((value) => Math.min(Math.max(value, Math.min(total, initial)), total))
  }, [total, initial])

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (count >= total) return
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setCount((value) => Math.min(total, value + step))
        }
      },
      { rootMargin: "400px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [count, total, step])

  return {
    visibleCount: Math.min(count, total),
    sentinelRef,
    hasMore: count < total,
    showMore: () => setCount((value) => Math.min(total, value + step)),
  }
}
