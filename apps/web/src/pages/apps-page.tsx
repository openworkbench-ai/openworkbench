import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { fetchApps, type AppInfo } from "@/lib/api"
import { PageHeader } from "@/components/shell/page-header"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Heading, Muted } from "@/components/ui/typography"

function AppRow({ app }: { app: AppInfo }) {
  return (
    <Link to={`/apps/${app.id}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-foreground/[0.03]">
      <div
        className="grid size-10 shrink-0 place-items-center rounded-lg text-lg"
        style={{ backgroundColor: app.color ?? "var(--muted)" }}
      >
        {app.emoji ?? "🧩"}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium leading-tight">{app.name}</p>
        <p className="truncate text-sm leading-tight text-muted-foreground">{app.description}</p>
      </div>
      <Badge variant="muted">Installed</Badge>
    </Link>
  )
}

function AppsPage() {
  const [apps, setApps] = useState<AppInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  useEffect(() => {
    fetchApps()
      .then(({ apps }) => setApps(apps))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const filtered = useMemo(() => {
    if (!apps) return apps
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter((app) => app.name.toLowerCase().includes(q) || app.description.toLowerCase().includes(q))
  }, [apps, query])

  return (
    <>
      <PageHeader breadcrumb="APPS · OVERVIEW" />

      <div className="flex-1 overflow-y-auto px-6 py-8 sm:px-10">
        <div className="mx-auto w-full max-w-3xl">
          <Heading level="h1" as="h1">
            Your apps
          </Heading>
          <Muted className="mt-2 max-w-[52ch]">
            Installed capabilities. Your agent uses these automatically; you manage what they can touch.
          </Muted>

          <Input
            className="mt-6"
            placeholder="Search installed apps…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {error ? <p className="mt-6 text-sm text-destructive">{error}</p> : null}

          {apps && apps.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">No apps installed yet.</p> : null}

          {filtered && filtered.length === 0 && apps && apps.length > 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">No apps match “{query}”.</p>
          ) : null}

          {filtered && filtered.length > 0 ? (
            <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card shadow-paper">
              {filtered.map((app) => (
                <AppRow key={app.id} app={app} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

export { AppsPage }
