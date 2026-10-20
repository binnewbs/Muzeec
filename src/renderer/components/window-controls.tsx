import { useEffect, useState } from "react"
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/ipc"

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    void api.windowMaximized().then((result) => {
      if (alive && result.ok) setMaximized(result.data)
    })
    const off = api.onWindowMaximized(setMaximized)
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div className="app-no-drag flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void api.windowMinimize()}
      >
        <MinusIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => {
          setMaximized((value) => !value)
          void api.windowToggleMaximize()
        }}
      >
        {maximized ? <CopyIcon /> : <SquareIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Exit Muzeec"
        title="Exit"
        className="hover:bg-destructive/10 hover:text-destructive"
        onClick={() => void api.windowQuit()}
      >
        <XIcon />
      </Button>
    </div>
  )
}
