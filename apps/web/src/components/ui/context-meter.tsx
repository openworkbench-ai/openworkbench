import { cn } from "@/lib/utils"

interface ContextMeterProps extends React.ComponentProps<"div"> {
  used: number
  total: number
  label?: string
  /** Fraction of the window at which the bar warns, 0–1. */
  warnAt?: number
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** How much of the context window a conversation has spent. */
function ContextMeter({
  used,
  total,
  label = "Context",
  warnAt = 0.85,
  className,
  ...props
}: ContextMeterProps) {
  const ratio = total > 0 ? Math.min(used / total, 1) : 0
  const percent = Math.round(ratio * 100)

  return (
    <div data-slot="context-meter" className={cn("flex min-w-0 flex-col gap-1.5", className)} {...props}>
      <div className="flex items-baseline justify-between gap-3 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {compact.format(used)} / {compact.format(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} used`}
        className="h-1 w-full overflow-hidden rounded-full bg-input"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            ratio >= warnAt ? "bg-destructive" : ratio >= 0.6 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export { ContextMeter }
