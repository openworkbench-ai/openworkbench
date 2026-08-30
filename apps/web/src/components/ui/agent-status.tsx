import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { ShimmerText, TypingDots } from "@/components/ui/streaming"

const agentStatusVariants = cva(
  "inline-flex w-fit items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[0.625rem] uppercase tracking-[0.12em]",
  {
    variants: {
      state: {
        idle: "border-border bg-card text-muted-foreground",
        thinking: "border-ocean/45 bg-ocean-soft/50 text-foreground",
        working: "border-clay/50 bg-clay-soft/50 text-foreground",
        waiting: "border-warning/50 bg-clay-soft/40 text-foreground",
        done: "border-success/40 bg-fern-100/60 text-foreground dark:bg-fern-800/50",
        error: "border-destructive/45 bg-destructive/10 text-foreground",
      },
    },
    defaultVariants: { state: "idle" },
  },
)

const dotTone: Record<string, string> = {
  idle: "bg-muted-foreground",
  thinking: "bg-ocean",
  working: "bg-clay",
  waiting: "bg-warning",
  done: "bg-success",
  error: "bg-destructive",
}

interface AgentStatusProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof agentStatusVariants> {
  /** Animate the label while the agent is mid-turn. */
  live?: boolean
}

/** Pill describing what the agent is doing right now. */
function AgentStatus({ className, state = "idle", live, children, ...props }: AgentStatusProps) {
  const animated = live ?? (state === "thinking" || state === "working")

  return (
    <span data-slot="agent-status" data-state={state} className={cn(agentStatusVariants({ state }), className)} {...props}>
      {animated ? (
        <TypingDots className={cn("[&>span]:size-1", dotTone[state ?? "idle"])} label="Agent is working" />
      ) : (
        <span className={cn("size-1.5 rounded-full", dotTone[state ?? "idle"])} aria-hidden="true" />
      )}
      {animated ? <ShimmerText>{children}</ShimmerText> : children}
    </span>
  )
}

export { AgentStatus, agentStatusVariants }
