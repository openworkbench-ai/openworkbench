import { useState, type FormEvent } from "react"
import { LockKeyhole } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { login } from "@/lib/api"

function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setSubmitting(true)
    try {
      await login(password)
      onAuthenticated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.")
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="mb-2 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground">
            <LockKeyhole className="size-5" />
          </span>
          <CardTitle>Open Workbench</CardTitle>
          <CardDescription>Enter the showcase password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={handleSubmit}>
            <Input
              aria-invalid={Boolean(error)}
              aria-label="Password"
              autoComplete="current-password"
              autoFocus
              disabled={submitting}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              required
              type="password"
              value={password}
            />
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
            <Button className="w-full" disabled={submitting || !password} type="submit">
              {submitting ? "Unlocking…" : "Unlock workbench"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

export { LoginGate }
