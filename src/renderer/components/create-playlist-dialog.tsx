import { useEffect, useState } from "react"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { api, errorMessage, unwrap } from "@/lib/ipc"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (playlistId: string, title: string) => void
}

export function CreatePlaylistDialog({ open, onOpenChange, onCreated }: Props) {
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setTitle("")
    setError(null)
    setBusy(false)
  }, [open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      const id = await unwrap(api.playlistCreate({ title: value }))
      toast.success(`Created “${value}”`)
      onCreated?.(id, value)
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New playlist</DialogTitle>
          <DialogDescription>Give your playlist a name. You can add songs afterwards.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="new-playlist-title">Name</FieldLabel>
              <Input
                id="new-playlist-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="My playlist"
                maxLength={150}
                aria-invalid={Boolean(error)}
              />
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
