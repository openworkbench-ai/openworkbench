import { Route, Routes } from "react-router-dom"

import { Sidebar } from "@/components/shell/sidebar"
import { AgentPage } from "@/pages/agent-page"
import { AppsPage } from "@/pages/apps-page"

function App() {
  return (
    <div className="flex h-dvh bg-canvas">
      <Sidebar />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <Routes>
          <Route path="/" element={<AgentPage />} />
          <Route path="/apps" element={<AppsPage />} />
        </Routes>
      </main>
    </div>
  )
}

export { App }
