import { useEffect, useState } from "react"
import { Route, Routes } from "react-router-dom"

import { LoginGate } from "@/components/auth/login-gate"
import { Sidebar } from "@/components/shell/sidebar"
import { Toaster } from "@/components/ui/toast"
import { AUTH_REQUIRED_EVENT, fetchAuthStatus } from "@/lib/api"
import { AgentPage } from "@/pages/agent-page"
import { AppDetailPage } from "@/pages/app-detail-page"
import { AppsPage } from "@/pages/apps-page"
import { BuildPage } from "@/pages/build-page"

function App() {
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "required">("checking")

  useEffect(() => {
    const requireAuth = () => setAuthState("required")
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuth)
    fetchAuthStatus()
      .then(({ authenticated }) => setAuthState(authenticated ? "authenticated" : "required"))
      .catch(() => setAuthState("required"))
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuth)
  }, [])

  if (authState === "checking") {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">Opening workbench…</span>
      </main>
    )
  }

  if (authState === "required") {
    return <LoginGate onAuthenticated={() => setAuthState("authenticated")} />
  }

  return (
    <div className="flex h-dvh bg-canvas">
      <Sidebar />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <Routes>
          <Route path="/" element={<AgentPage />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:id" element={<AppDetailPage />} />
          <Route path="/build" element={<BuildPage />} />
        </Routes>
      </main>
      <Toaster />
    </div>
  )
}

export { App }
