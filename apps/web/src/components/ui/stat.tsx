import { cn } from "@/lib/utils"

interface StatProps extends React.ComponentProps<"div"> {
  value: React.ReactNode
  label: React.ReactNode
  trend?: React.ReactNode
}

/** Figure-and-caption block: display serif number over a mono caption. */
function Stat({ value, label, trend, className, ...props }: StatProps) {
  return (
    <div data-slot="stat" className={cn("flex flex-col gap-1", className)} {...props}>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-4xl leading-none tracking-[-0.02em]">{value}</span>
        {trend ? <span className="font-mono text-xs text-muted-foreground">{trend}</span> : null}
      </div>
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
    </div>
  )
}

export { Stat }
