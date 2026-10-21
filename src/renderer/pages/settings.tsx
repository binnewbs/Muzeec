import { useEffect, useState } from "react"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import type { LyricsProviderInfo } from "@shared/types"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, unwrap } from "@/lib/ipc"
import { useAuth } from "@/lib/store/auth"
import { useSettings } from "@/lib/store/settings"

export default function SettingsPage() {
  const { state, loading, login, logout } = useAuth()
  const { settings, update } = useSettings()
  const [providers, setProviders] = useState<LyricsProviderInfo[]>([])
  const user = state.user

  useEffect(() => {
    void unwrap(api.lyricsProviders()).then(setProviders).catch(() => undefined)
  }, [])

  const orderedProviders = [...providers].sort((a, b) => {
    const left = settings.lyricsSources.indexOf(a.id)
    const right = settings.lyricsSources.indexOf(b.id)
    return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right)
  })

  const toggleSource = (id: string, enabled: boolean) => {
    const sources = [...settings.lyricsSources]
    if (enabled) {
      if (sources.includes(id)) return
      const defaultIndex = providers.findIndex((provider) => provider.id === id)
      const at = sources.findIndex(
        (existing) => providers.findIndex((provider) => provider.id === existing) > defaultIndex,
      )
      sources.splice(at < 0 ? sources.length : at, 0, id)
    } else {
      const at = sources.indexOf(id)
      if (at >= 0) sources.splice(at, 1)
    }
    void update({ lyricsSources: sources })
  }

  const moveSource = (id: string, direction: -1 | 1) => {
    const sources = [...settings.lyricsSources]
    const at = sources.indexOf(id)
    const to = at + direction
    if (at < 0 || to < 0 || to >= sources.length) return
    ;[sources[at], sources[to]] = [sources[to], sources[at]]
    void update({ lyricsSources: sources })
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Settings</h1>

      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="playback">Playback</TabsTrigger>
          <TabsTrigger value="lyrics">Lyrics</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle>YouTube Music account</CardTitle>
              <CardDescription>Likes, playlists and library stay on your account.</CardDescription>
            </CardHeader>
            <CardContent>
              {state.signedIn && user ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="size-10">
                      <AvatarImage src={user.avatar ?? undefined} alt="" />
                      <AvatarFallback>{(user.name ?? "Y").slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{user.name ?? "Signed in"}</span>
                      <span className="text-xs text-muted-foreground">Account {user.authUser}</span>
                    </div>
                  </div>
                  <Separator />
                  <Button variant="outline" className="w-fit" disabled={loading} onClick={() => void logout()}>
                    Sign out
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-start gap-3">
                  <p className="text-sm text-muted-foreground">
                    Sign in through Google's own window. Cookies stay in the app session and never reach the UI.
                  </p>
                  <Button disabled={loading} onClick={() => void login()}>
                    Sign in
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="playback" className="pt-4">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Audio quality</CardTitle>
                <CardDescription>High prefers Opus 251, then AAC 140.</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Quality</FieldTitle>
                    </FieldContent>
                    <ToggleGroup
                      value={[settings.quality]}
                      onValueChange={(value) => {
                        const quality = value[0]
                        if (quality === "high" || quality === "normal") void update({ quality })
                      }}
                    >
                      <ToggleGroupItem value="normal">Normal</ToggleGroupItem>
                      <ToggleGroupItem value="high">High</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Low memory mode</FieldTitle>
                      <FieldDescription>Smaller in-memory caches for low-RAM machines.</FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.lowMemory}
                      onCheckedChange={(checked) => void update({ lowMemory: checked })}
                    />
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Transitions</CardTitle>
                <CardDescription>How one track flows into the next.</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Gapless playback</FieldTitle>
                      <FieldDescription>
                        Preload the next track and start it the instant the current one ends.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.gaplessEnabled}
                      onCheckedChange={(checked) => void update({ gaplessEnabled: checked })}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Crossfade</FieldTitle>
                      <FieldDescription>Fade out the current track while fading in the next.</FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.crossfadeEnabled}
                      onCheckedChange={(checked) => void update({ crossfadeEnabled: checked })}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Fade duration</FieldTitle>
                      <FieldDescription>Seconds of overlap between tracks. Clamped to 1–10.</FieldDescription>
                    </FieldContent>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      value={settings.crossfadeSeconds}
                      className="w-28"
                      disabled={!settings.crossfadeEnabled}
                      aria-label="Crossfade duration in seconds"
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        if (Number.isFinite(value)) {
                          void update({ crossfadeSeconds: Math.max(1, Math.min(10, Math.round(value))) })
                        }
                      }}
                    />
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="lyrics" className="pt-4">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Lyrics</CardTitle>
                <CardDescription>
                  Time-synced lyrics from third-party providers. Requests happen on this device.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Enable lyrics</FieldTitle>
                      <FieldDescription>Show the lyrics button in the player bar.</FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.lyricsEnabled}
                      onCheckedChange={(checked) => void update({ lyricsEnabled: checked })}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Prefer syllable timing</FieldTitle>
                      <FieldDescription>
                        Wait for a lower-priority word-timed result instead of taking the first line-timed one.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.lyricsPreferSyllableTiming}
                      onCheckedChange={(checked) => void update({ lyricsPreferSyllableTiming: checked })}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Lyric offset</FieldTitle>
                      <FieldDescription>Positive values delay lyrics. Clamped to ±5 seconds.</FieldDescription>
                    </FieldContent>
                    <Input
                      type="number"
                      min={-5000}
                      max={5000}
                      step={100}
                      value={settings.lyricsOffsetMs}
                      className="w-28"
                      aria-label="Lyric offset in milliseconds"
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        if (Number.isFinite(value)) void update({ lyricsOffsetMs: value })
                      }}
                    />
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Providers</CardTitle>
                <CardDescription>
                  Enabled providers are contacted in this order. Word-timed results win outright.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {providers.length ? (
                  <div className="flex flex-col gap-2">
                    {orderedProviders.map((provider) => {
                      const sourceIndex = settings.lyricsSources.indexOf(provider.id)
                      const enabled = sourceIndex >= 0
                      return (
                        <div key={provider.id} className="flex items-center gap-3 rounded-xl border p-3">
                          <Switch
                            checked={enabled}
                            aria-label={`Use ${provider.label}`}
                            onCheckedChange={(checked) => toggleSource(provider.id, checked)}
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">{provider.label}</span>
                              <Badge variant="outline">{provider.wordSynced ? "Word timing" : "Line / plain"}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{provider.description}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Move ${provider.label} up`}
                              disabled={!enabled || sourceIndex <= 0}
                              onClick={() => moveSource(provider.id, -1)}
                            >
                              <ChevronUpIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Move ${provider.label} down`}
                              disabled={!enabled || sourceIndex >= settings.lyricsSources.length - 1}
                              onClick={() => moveSource(provider.id, 1)}
                            >
                              <ChevronDownIcon />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Loading providers…</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="data" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Data</CardTitle>
              <CardDescription>Local preferences only. Playback history is written to your account.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Send playback history</FieldTitle>
                    <FieldDescription>Best-effort play and watchtime pings to YouTube.</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={settings.historyEnabled}
                    onCheckedChange={(checked) => void update({ historyEnabled: checked })}
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Search history</FieldTitle>
                    <FieldDescription>Recent searches stay on this device.</FieldDescription>
                  </FieldContent>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!settings.searchHistory.length}
                    onClick={() => void update({ searchHistory: [] })}
                  >
                    Clear
                  </Button>
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Theme</FieldTitle>
                    <FieldDescription>System follows your desktop appearance.</FieldDescription>
                  </FieldContent>
                  <ToggleGroup
                    value={[settings.theme]}
                    onValueChange={(value) => {
                      const theme = value[0]
                      if (theme === "light" || theme === "dark" || theme === "system") void update({ theme })
                    }}
                  >
                    <ToggleGroupItem value="light">Light</ToggleGroupItem>
                    <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                    <ToggleGroupItem value="system">System</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
