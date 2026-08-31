import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowDown, ArrowLeft, ArrowUp, ChevronsUpDown } from "lucide-react"

import {
  activateApp,
  deactivateApp,
  fetchAppData,
  fetchAppEntities,
  fetchAppSkills,
  fetchAppTools,
  fetchApps,
  type AppInfo,
  type EntityInfo,
  type SkillInfo,
  type ToolInfo,
} from "@/lib/api"
import { PageHeader } from "@/components/shell/page-header"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/ui/markdown"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Stat } from "@/components/ui/stat"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { Heading, Muted } from "@/components/ui/typography"

/** The engine caps `limit` at 200 (see engine/domain/query.go) — the largest batch we can pull in one request for client-side sort/filter. */
const MAX_ROWS = 200

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    load()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error }
}

function OverviewTab({
  app,
  onStatusChange,
}: {
  app: AppInfo
  onStatusChange: (status: "active" | "inactive") => void
}) {
  const { data: toolsData } = useAsync(() => fetchAppTools(app.id), [app.id])
  const { data: skillsData } = useAsync(() => fetchAppSkills(app.id), [app.id])
  const { data: entitiesData } = useAsync(() => fetchAppEntities(app.id), [app.id])
  const [pending, setPending] = useState(false)

  const isActive = app.status !== "inactive"

  async function toggle() {
    setPending(true)
    try {
      const result = isActive ? await deactivateApp(app.id) : await activateApp(app.id)
      onStatusChange(result.status)
      toast(result.status === "inactive" ? `${app.name} disabled` : `${app.name} enabled`)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6 shadow-paper">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Heading level="h3" as="h3">
              About
            </Heading>
            <Muted className="mt-1 max-w-[52ch]">{app.description}</Muted>
          </div>
          {app.manageable ? (
            <Badge variant={isActive ? "muted" : "outline"}>{isActive ? "Active" : "Inactive"}</Badge>
          ) : null}
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div>
            <dt className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">App ID</dt>
            <dd className="mt-1 font-mono text-sm">{app.id}</dd>
          </div>
          <Stat value={toolsData ? toolsData.tools.length : "—"} label="Tools" />
          <Stat value={skillsData ? skillsData.skills.length : "—"} label="Skills" />
          <Stat value={entitiesData ? entitiesData.entities.length : "—"} label="Entities" />
        </dl>
      </div>

      {app.manageable ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-6 shadow-paper">
          <div>
            <p className="font-medium">{isActive ? "Disable this app" : "Enable this app"}</p>
            <Muted className="mt-1 max-w-[48ch]">
              {isActive
                ? "Stops the agent from using this app's tools until you re-enable it. No data is deleted."
                : "Lets the agent use this app's tools again."}
            </Muted>
          </div>
          <Switch checked={isActive} disabled={pending} onCheckedChange={toggle} />
        </div>
      ) : null}
    </div>
  )
}

function ToolsTab({ appId }: { appId: string }) {
  const { data, error } = useAsync(() => fetchAppTools(appId), [appId])

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
  if (!data) return <Skeleton className="h-32" />

  const tools: ToolInfo[] = data.tools
  if (tools.length === 0) return <Alert><AlertDescription>This app has no tools.</AlertDescription></Alert>

  return (
    <Accordion type="multiple">
      {tools.map((tool) => (
        <AccordionItem key={tool.id} value={tool.id}>
          <AccordionTrigger>
            <span className="flex items-center gap-3">
              <span className="font-mono text-base">{tool.name}</span>
              <Badge variant="muted">
                {tool.params?.length ?? 0} param{tool.params?.length === 1 ? "" : "s"}
              </Badge>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            {tool.description ? <p className="mb-3">{tool.description}</p> : null}
            {tool.params && tool.params.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Param</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Required</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tool.params.map((param) => (
                    <TableRow key={param.id}>
                      <TableCell>{param.name}</TableCell>
                      <TableCell>{param.type}</TableCell>
                      <TableCell>{param.required ? "Yes" : "No"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}

function SkillsTab({ appId }: { appId: string }) {
  const { data, error } = useAsync(() => fetchAppSkills(appId), [appId])

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
  if (!data) return <Skeleton className="h-32" />

  const skills: SkillInfo[] = data.skills
  if (skills.length === 0) return <Alert><AlertDescription>This app has no skills.</AlertDescription></Alert>

  return (
    <Accordion type="multiple">
      {skills.map((skill) => (
        <AccordionItem key={skill.id} value={skill.id}>
          <AccordionTrigger>{skill.name}</AccordionTrigger>
          <AccordionContent>
            {skill.description ? <p className="mb-3">{skill.description}</p> : null}
            <Markdown content={skill.content} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}

function EntityTable({
  rows,
  columns,
  totalOnServer,
}: {
  rows: Record<string, unknown>[]
  columns: string[]
  totalOnServer: number
}) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState("")

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columns.map((column) => ({
        accessorKey: column,
        header: column,
        cell: (info) => formatCell(info.getValue()),
      })),
    [columns],
  )

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 15 } },
  })

  const filteredCount = table.getFilteredRowModel().rows.length
  const { pageIndex, pageSize } = table.getState().pagination

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <Input
          className="w-64"
          placeholder="Filter rows…"
          value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)}
        />
        {totalOnServer > rows.length ? (
          <Muted>
            Showing first {rows.length} of {totalOnServer} rows
          </Muted>
        ) : null}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="divide-x divide-border">
                {headerGroup.headers.map((header) => {
                  const sortState = header.column.getIsSorted()
                  return (
                    <TableHead key={header.id} className="px-0 first:pl-0 last:pr-0">
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left hover:text-foreground"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortState === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : sortState === "desc" ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="px-3 py-6 text-center text-muted-foreground">
                  No rows match “{globalFilter}”.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="divide-x divide-border">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-3 font-mono text-[0.8125rem] first:pl-3 last:pr-3">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <Muted>
          {filteredCount === 0 ? 0 : pageIndex * pageSize + 1}–{Math.min(filteredCount, (pageIndex + 1) * pageSize)} of{" "}
          {filteredCount}
        </Muted>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            Prev
          </Button>
          <Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

function DataTab({ appId }: { appId: string }) {
  const { data: entitiesData, error: entitiesError } = useAsync(() => fetchAppEntities(appId), [appId])
  const [entityName, setEntityName] = useState<string | null>(null)

  const entities: EntityInfo[] = entitiesData?.entities ?? []
  useEffect(() => {
    if (entities.length > 0 && entityName === null) setEntityName(entities[0].name)
  }, [entities, entityName])

  const selectedEntity = entities.find((entity) => entity.name === entityName) ?? null

  const { data: page, error: pageError } = useAsync(
    () => (entityName ? fetchAppData(appId, entityName, { limit: MAX_ROWS, offset: 0 }) : Promise.resolve(null)),
    [appId, entityName],
  )

  const columns = useMemo(() => {
    if (selectedEntity) return selectedEntity.fields.map((field) => field.name)
    if (page?.data.length) return Object.keys(page.data[0])
    return []
  }, [selectedEntity, page])

  if (entitiesError) return <Alert variant="destructive"><AlertDescription>{entitiesError}</AlertDescription></Alert>
  if (!entitiesData) return <Skeleton className="h-32" />
  if (entities.length === 0) return <Alert><AlertDescription>This app has no data entities.</AlertDescription></Alert>

  return (
    <div>
      <Select
        value={entityName ?? undefined}
        onValueChange={(value) => setEntityName(value)}
      >
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Choose an entity…" />
        </SelectTrigger>
        <SelectContent>
          {entities.map((entity) => (
            <SelectItem key={entity.id} value={entity.name}>
              {entity.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="mt-5">
        {pageError ? (
          <Alert variant="destructive"><AlertDescription>{pageError}</AlertDescription></Alert>
        ) : !page ? (
          <Skeleton className="h-32" />
        ) : page.data.length === 0 ? (
          <Alert><AlertDescription>No rows in “{entityName}” yet.</AlertDescription></Alert>
        ) : (
          <EntityTable key={entityName} rows={page.data} columns={columns} totalOnServer={page.total} />
        )}
      </div>
    </div>
  )
}

function formatCell(value: unknown): string {
  if (value == null) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function AppDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [app, setApp] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchApps()
      .then(({ apps }) => setApp(apps.find((candidate) => candidate.id === id) ?? null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [id])

  if (!id) return null

  return (
    <>
      <PageHeader breadcrumb={`APPS · ${app?.name.toUpperCase() ?? id.toUpperCase()}`}>
        <Button asChild variant="ghost" size="sm">
          <Link to="/apps">
            <ArrowLeft className="size-4" />
            Back to apps
          </Link>
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-6 py-8 sm:px-10">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex items-center gap-3">
            <div
              className="grid size-10 shrink-0 place-items-center rounded-lg text-lg"
              style={{ backgroundColor: app?.color ?? "var(--muted)" }}
            >
              {app?.emoji ?? "🧩"}
            </div>
            <Heading level="h1" as="h1">
              {app?.name ?? id}
            </Heading>
          </div>
          {error ? (
            <Alert className="mt-6" variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Tabs defaultValue="overview" className="mt-8">
            <TabsList variant="underline">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="data">Data</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              {app ? (
                <OverviewTab
                  app={app}
                  onStatusChange={(status) => setApp((prev) => (prev ? { ...prev, status } : prev))}
                />
              ) : (
                <Skeleton className="h-32" />
              )}
            </TabsContent>
            <TabsContent value="tools">
              <ToolsTab appId={id} />
            </TabsContent>
            <TabsContent value="skills">
              <SkillsTab appId={id} />
            </TabsContent>
            <TabsContent value="data">
              <DataTab appId={id} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  )
}

export { AppDetailPage }
