import { useEffect, useState } from "react"
import { NavLink } from "react-router-dom"
import { Hammer, LayoutGrid, MessageSquare } from "lucide-react"

import { cn } from "@/lib/utils"
import { fetchApps } from "@/lib/api"
import { ThemeToggle } from "@/components/shell/theme-toggle"

const destinations = [
  { to: "/", label: "Chat", icon: MessageSquare },
  { to: "/apps", label: "Apps", icon: LayoutGrid },
  { to: "/build", label: "Build", icon: Hammer },
]

/** Left rail: brand mark, the screens this build ships, and app count. */
function Sidebar() {
  const [appCount, setAppCount] = useState<number | null>(null)

  useEffect(() => {
    fetchApps()
      .then(({ apps }) => setAppCount(apps.length))
      .catch(() => {})
  }, [])

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <span className="grid size-7 shrink-0 place-items-center text-lg">🧰</span>
        <span className="font-display text-base leading-none font-semibold tracking-tight">Open Workbench</span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {destinations.map((destination) => (
          <NavLink
            key={destination.to}
            to={destination.to}
            end={destination.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                isActive
                  ? "bg-foreground/[0.07] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <destination.icon className="size-4" />
            {destination.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-2 pt-3">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">
          {appCount == null ? "…" : `${appCount} app${appCount === 1 ? "" : "s"} installed`}
        </span>
        <ThemeToggle />
      </div>
    </aside>
  )
}

export { Sidebar }
