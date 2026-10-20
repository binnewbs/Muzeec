import { HistoryIcon } from "lucide-react"
import { BrowseView } from "@/components/browse-view"
import { PageEmpty } from "@/components/page-states"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/store/auth"
import { useSettings } from "@/lib/store/settings"
import { useView } from "@/lib/store/view"

export default function HistoryPage() {
  const signedIn = useAuth((state) => state.state.signedIn)
  const login = useAuth((state) => state.login)
  const loading = useAuth((state) => state.loading)
  const historyEnabled = useSettings((state) => state.settings.historyEnabled)
  const navigate = useView((state) => state.navigate)

  if (!signedIn) {
    return (
      <PageEmpty
        title="Your listening history"
        description="Sign in to see what you have played on YouTube Music."
        action={
          <div className="flex gap-2">
            <Button disabled={loading} onClick={() => void login()}>
              Sign in
            </Button>
            <Button variant="ghost" onClick={() => navigate({ name: "home" })}>
              Back home
            </Button>
          </div>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <HistoryIcon className="size-4" />
        <span className="text-sm">
          {historyEnabled
            ? "Recently played across YouTube Music"
            : "History reporting is off in settings — only plays from other devices will appear here."}
        </span>
      </div>
      <BrowseView browseId="FEmusic_history" title="History" />
    </div>
  )
}
