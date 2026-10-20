import { useEffect, useState } from "react"
import { CompassIcon, HomeIcon, LibraryIcon, SearchIcon, SettingsIcon } from "lucide-react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useView } from "@/lib/store/view"
import { useAuth } from "@/lib/store/auth"

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const navigate = useView((state) => state.navigate)
  const login = useAuth((state) => state.login)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const go = (view: Parameters<typeof navigate>[0]) => {
    navigate(view)
    setOpen(false)
    setQuery("")
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a page or search">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search or jump to…" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {query.trim() ? (
          <CommandGroup heading="Search">
            <CommandItem value={`search-${query}`} onSelect={() => go({ name: "search", query: query.trim() })}>
              <SearchIcon />
              Search for “{query.trim()}”
            </CommandItem>
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Navigate">
          <CommandItem value="home" onSelect={() => go({ name: "home" })}>
            <HomeIcon />
            Home
          </CommandItem>
          <CommandItem value="explore" onSelect={() => go({ name: "explore" })}>
            <CompassIcon />
            Explore
          </CommandItem>
          <CommandItem value="library" onSelect={() => go({ name: "library" })}>
            <LibraryIcon />
            Library
          </CommandItem>
          <CommandItem value="search" onSelect={() => go({ name: "search" })}>
            <SearchIcon />
            Search
          </CommandItem>
          <CommandItem value="settings" onSelect={() => go({ name: "settings" })}>
            <SettingsIcon />
            Settings
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Account">
          <CommandItem
            value="sign-in"
            onSelect={() => {
              setOpen(false)
              void login()
            }}
          >
            Sign in
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>Navigate with ↑ ↓, select with ↵</span>
        <CommandShortcut>⌘K</CommandShortcut>
      </div>
    </CommandDialog>
  )
}
