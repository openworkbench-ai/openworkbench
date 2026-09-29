import { useState, type FormEvent } from "react"
import { ArrowRight, LockKeyhole } from "lucide-react"

import { LandingPage } from "@/components/auth/landing-page"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { login, register, type AuthUser, type SignInMethod } from "@/lib/api"

const MIN_PASSWORD_LENGTH = 8

function LoginGate({ signIn, onAuthenticated }: { signIn: SignInMethod; onAuthenticated: (user: AuthUser) => void }) {
  if (signIn.kind === "redirect") {
    return (
      <LandingPage
        onEnter={() => window.location.assign(signIn.url)}
        accessForm={
          <div className="showcase-access">
            <p className="diagram-label"><LockKeyhole aria-hidden="true" /> Your workbench</p>
            <h3>Welcome back.</h3>
            <p>Sign in to open your apps and keep building.</p>
            <Button className="h-12 w-full" onClick={() => window.location.assign(signIn.url)} type="button">
              Continue to sign in
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        }
      />
    )
  }
  return <PasswordForm signupOpen={signIn.signupOpen} onAuthenticated={onAuthenticated} />
}

function PasswordForm({ signupOpen, onAuthenticated }: { signupOpen: boolean; onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const signingUp = mode === "signup"

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || !email || !password) return
    setError("")
    setSubmitting(true)
    try {
      onAuthenticated(await (signingUp ? register : login)(email, password))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.")
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  function switchMode(next: "signin" | "signup") {
    setMode(next)
    setError("")
    setPassword("")
  }

  function enterWorkbench() {
    document.getElementById("access")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" })
    document.getElementById("workbench-email")?.focus({ preventScroll: true })
  }

  return (
    <LandingPage onEnter={enterWorkbench} accessForm={
      <form aria-label={signingUp ? "Create account" : "Sign in"} aria-busy={submitting} className="showcase-access" onSubmit={handleSubmit}>
        <p className="diagram-label"><LockKeyhole aria-hidden="true" /> {signingUp ? "New account" : "Your workbench"}</p>
        <h3>{signingUp ? "Create your workbench." : "Welcome back."}</h3>
        <p>{signingUp ? "Sign up to build apps of your own. Your apps and their data stay private to your account." : "Sign in to open your apps and keep building."}</p>
        <label htmlFor="workbench-email">Email</label>
        <Input
          id="workbench-email"
          name="email"
          className="h-12 text-base"
          autoComplete="email"
          disabled={submitting}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={email}
        />
        <label htmlFor="workbench-password">Password</label>
        <Input
          id="workbench-password"
          name="password"
          className="h-12 text-base"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "login-error login-help" : "login-help"}
          autoComplete={signingUp ? "new-password" : "current-password"}
          disabled={submitting}
          minLength={signingUp ? MIN_PASSWORD_LENGTH : undefined}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={signingUp ? `At least ${MIN_PASSWORD_LENGTH} characters` : "Enter password"}
          required
          type="password"
          value={password}
        />
        {error ? <p id="login-error" className="text-destructive" role="alert">{error}</p> : null}
        <Button className="h-12 w-full" disabled={submitting || !email || !password} type="submit">
          {submitting ? (signingUp ? "Creating account…" : "Signing in…") : signingUp ? "Create account" : "Sign in"}
          <ArrowRight aria-hidden="true" />
        </Button>
        <p id="login-help" className="access-help">
          {signupOpen ? (
            signingUp ? (
              <>Already have an account? <button type="button" className="underline" onClick={() => switchMode("signin")}>Sign in</button></>
            ) : (
              <>New here? <button type="button" className="underline" onClick={() => switchMode("signup")}>Create an account</button></>
            )
          ) : (
            "Sign-ups are closed on this workbench."
          )}
        </p>
      </form>
    } />
  )
}

export { LoginGate }
