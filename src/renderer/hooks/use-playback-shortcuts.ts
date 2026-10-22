import { useEffect } from "react"
import { usePlayer } from "@/lib/store/player"
import { seekBy, togglePlay } from "@/player/controller"

/** Seconds moved by the global Left/Right shortcuts. */
const SEEK_STEP = 5

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "password",
  "url",
  "tel",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
])

/** Typing in a field shouldn't trigger the player. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type.toLowerCase()
    return type === "" || TEXT_INPUT_TYPES.has(type)
  }
  return Boolean(
    target.closest("[contenteditable='true'], [role='textbox'], [role='searchbox'], [role='combobox']"),
  )
}

/**
 * Widgets that navigate with the arrow keys themselves. The global shortcuts
 * leave these alone so menus, lists, and sliders keep working.
 */
const ARROW_WIDGETS = [
  "[role='menu']",
  "[role='menubar']",
  "[role='menuitem']",
  "[role='menuitemradio']",
  "[role='menuitemcheckbox']",
  "[role='listbox']",
  "[role='option']",
  "[role='tree']",
  "[role='treeitem']",
  "[role='grid']",
  "[role='gridcell']",
  "[role='tablist']",
  "[role='tab']",
  "[role='radiogroup']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='toolbar']",
  "input[type='range']",
  "select",
].join(", ")

function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(ARROW_WIDGETS))
}

const isSpace = (event: KeyboardEvent) => event.code === "Space" || event.key === " "
const hasCommandModifier = (event: KeyboardEvent) => event.ctrlKey || event.metaKey || event.altKey

/**
 * Player shortcuts that work anywhere in the window, including while a menu or
 * button has focus: Space toggles playback and Left/Right seek five seconds.
 * Typing fields are exempt, and Left/Right yields to widgets that use arrows.
 */
export function usePlaybackShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasCommandModifier(event)) return
      if (event.isComposing || isTypingTarget(event.target)) return

      if (isSpace(event)) {
        event.preventDefault()
        event.stopPropagation()
        // Hold-to-repeat would otherwise stutter playback on and off.
        if (!event.repeat) togglePlay()
        return
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (event.shiftKey) return
      if (!usePlayer.getState().current) return
      if (ownsArrowKeys(event.target)) return

      event.preventDefault()
      event.stopPropagation()
      seekBy(event.key === "ArrowRight" ? SEEK_STEP : -SEEK_STEP)
    }

    // Also swallow the Space keyup so a focused button doesn't activate on release.
    const onKeyUp = (event: KeyboardEvent) => {
      if (hasCommandModifier(event) || isTypingTarget(event.target)) return
      if (!isSpace(event)) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
    }
  }, [])
}
