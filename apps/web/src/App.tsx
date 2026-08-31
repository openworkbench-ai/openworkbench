import { Route, Routes } from "react-router-dom"

import { Sidebar } from "@/components/shell/sidebar"
import { Toaster } from "@/components/ui/toast"
import { AgentPage } from "@/pages/agent-page"
import { AppDetailPage } from "@/pages/app-detail-page"
import { AppsPage } from "@/pages/apps-page"
import { BuildPage } from "@/pages/build-page"

function App() {
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
