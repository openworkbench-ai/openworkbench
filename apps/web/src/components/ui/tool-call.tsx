import { useState } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { AlertTriangle, Check, ChevronRight, CircleDashed, Loader2, Terminal } from "lucide-react"

import { cn } from "@/lib/utils"
import { CodeBlock } from "./code-block"

type ToolStatus = "pending" | "running" | "success" | "error"

const statusMeta: Record<ToolStatus, { icon: React.ElementType; label: string; className: string }> = {
  pending: { icon: CircleDashed, label: "Queued", className: "text-muted-foreground" },
  running: { icon: Loader2, label: "Running", className: "text-ocean" },
  success: { icon: Check, label: "Done", className: "text-success" },
  error: { icon: AlertTriangle, label: "Failed", className: "text-destructive" },
}

const toolCallVariants = cva("min-w-0 overflow-hidden rounded-lg border bg-card transition-colors", {
  variants: {
    status: {
      pending: "border-dashed border-border",
      running: "border-ocean/45",
      success: "border-border",
      error: "border-destructive/45",
    },
  },
  defaultVariants: { status: "success" },
})

interface ToolCallProps
  extends Omit<React.ComponentProps<"div">, "title">,
    Omit<VariantProps<typeof toolCallVariants>, "status"> {
  /** Tool identifier, e.g. `search_products`. */
  name: string
  status?: ToolStatus
  /** Wall-clock time, shown beside the status. */
  duration?: string
  /** One-line summary of what the call did, e.g. `12 results`. */
  summary?: React.ReactNode
  defaultOpen?: boolean
  icon?: React.ElementType
}

/**
 * A single tool invocation: what was called, how it went, and — behind a
 * disclosure — the arguments it received and what came back.
 */
function ToolCall({
  name,
  status = "success",
  duration,
  summary,
  defaultOpen = false,
  icon: Icon = Terminal,
  className,
  children,
  ...props
}: ToolCallProps) {
  const [open, setOpen] = useState(defaultOpen)
  const meta = statusMeta[status]
  const StatusIcon = meta.icon
  const collapsible = Boolean(children)

  return (
    <div data-slot="tool-call" data-status={status} className={cn(toolCallVariants({ status }), className)} {...props}>
      <button
        type="button"
        onClick={() => collapsible && setOpen((value) => !value)}
        aria-expanded={collapsible ? open : undefined}
        disabled={!collapsible}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left",
          collapsible && "transition-colors hover:bg-foreground/[0.03]",
          "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:-outline-offset-2",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{name}</span>

        {summary ? (
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">— {summary}</span>
        ) : null}

        <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em]", meta.className)}>
          <StatusIcon className={cn("size-3", status === "running" && "animate-spin motion-reduce:animate-none")} />
          {meta.label}
        </span>

        {duration ? <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">{duration}</span> : null}

        {collapsible ? (
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")}
            aria-hidden="true"
          />
        ) : null}
      </button>

      {collapsible && open ? (
        <div className="border-t border-border p-3 animate-in-fade">
          <div className="flex flex-col gap-3">{children}</div>
        </div>
      ) : null}
    </div>
  )
}

/** Labelled block inside a tool call — "Arguments", "Result", "Error". */
function ToolCallPanel({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
  return (
    <div data-slot="tool-call-panel" className={cn("min-w-0", className)} {...props}>
      <p className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

const INLINE_ARG_MAX_LENGTH = 72

/** Key/value read-out for tool arguments. Values too long or multi-line to sit on one row drop into a code block instead of truncating illegibly. */
function ToolCallArgs({
  args,
  className,
  ...props
}: React.ComponentProps<"dl"> & { args: Record<string, unknown> }) {
  return (
    <dl
      data-slot="tool-call-args"
      className={cn("grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 font-mono text-xs", className)}
      {...props}
    >
      {Object.entries(args).map(([key, value]) => {
        const isString = typeof value === "string"
        const inline = isString ? value : JSON.stringify(value)
        const overflows = inline.length > INLINE_ARG_MAX_LENGTH || inline.includes("\n")

        if (overflows) {
          return (
            <div key={key} className="col-span-2 flex flex-col gap-1">
              <dt className="text-muted-foreground">{key}</dt>
              <dd>
                <CodeBlock code={isString ? value : JSON.stringify(value, null, 2)} language={isString ? "text" : "json"} />
              </dd>
            </div>
          )
        }

        return (
          <div key={key} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="truncate">{inline}</dd>
          </div>
        )
      })}
    </dl>
  )
}

/** Compact inline form for a call worth mentioning but not expanding. */
function ToolCallChip({
  name,
  status = "success",
  className,
  ...props
}: React.ComponentProps<"span"> & { name: string; status?: ToolStatus }) {
  const meta = statusMeta[status]
  const StatusIcon = meta.icon
  return (
    <span
      data-slot="tool-call-chip"
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[0.6875rem]",
        className,
      )}
      {...props}
    >
      <StatusIcon className={cn("size-3", meta.className, status === "running" && "animate-spin motion-reduce:animate-none")} />
      {name}
    </span>
  )
}

export { ToolCall, ToolCallPanel, ToolCallArgs, ToolCallChip, type ToolStatus }
