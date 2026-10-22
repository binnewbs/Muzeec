import { DownloadIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Flat, dark offline artwork shared by the Library card and the downloads page. */
export function DownloadsArtwork({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center overflow-hidden bg-zinc-900 text-zinc-500", className)}>
      <DownloadIcon className="size-[32%]" strokeWidth={1.5} />
    </div>
  )
}
