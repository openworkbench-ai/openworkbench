import { useRef, useState, type FormEvent } from "react"
import { ArrowRight, LockKeyhole } from "lucide-react"

import { LandingPage } from "@/components/auth/landing-page"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { login } from "@/lib/api"

function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || !password) return
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

  function enterShowcase() {
    document.getElementById("access")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" })
    passwordRef.current?.focus({ preventScroll: true })
  }

  return (
    <LandingPage onEnter={enterShowcase} accessForm={
      <form aria-label="Unlock workbench" aria-busy={submitting} className="showcase-access" onSubmit={handleSubmit}>
        <p className="diagram-label"><LockKeyhole aria-hidden="true" /> Early private showcase</p>
        <h3>Come see what’s possible.</h3>
        <p>Have the shared password? Enter to explore the workbench and build an app of your own.</p>
        <label htmlFor="workbench-password">Showcase password</label>
        <Input
          ref={passwordRef}
          id="workbench-password"
          name="password"
          className="h-12 text-base"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "login-error login-help" : "login-help"}
          autoComplete="current-password"
          disabled={submitting}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter password"
          required
          type="password"
          value={password}
        />
        {error ? <p id="login-error" className="text-destructive" role="alert">{error}</p> : null}
        <Button className="h-12 w-full" disabled={submitting || !password} type="submit">{submitting ? "Unlocking…" : "Enter the showcase"}<ArrowRight aria-hidden="true" /></Button>
        <p id="login-help" className="access-help">Private access · Shared-password login</p>
      </form>
    } />
  )
}

export { LoginGate }
