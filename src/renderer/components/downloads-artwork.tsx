import { DownloadIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Flat offline artwork shared by the Library card and the downloads page. */
export function DownloadsArtwork({
  className,
  iconClassName = "size-[32%]",
}: {
  className?: string
  iconClassName?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden bg-zinc-200 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-500",
        className,
      )}
    >
      <DownloadIcon className={iconClassName} strokeWidth={1.5} />
    </div>
  )
}
