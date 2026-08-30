import { ShieldQuestion } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface ApprovalProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: React.ReactNode
  /** What exactly will run — a command, an endpoint, a file path. */
  detail?: React.ReactNode
  /** Why the agent needs permission, in one line. */
  reason?: React.ReactNode
  onAllow?: () => void
  onAllowAlways?: () => void
  onDeny?: () => void
  /** Set once the person has answered; the card keeps the record. */
  decision?: "allowed" | "denied"
}

/**
 * Permission gate for an action the agent cannot take unilaterally.
 * Stays in the transcript after answering so the decision is auditable.
 */
function Approval({
  title,
  detail,
  reason,
  onAllow,
  onAllowAlways,
  onDeny,
  decision,
  className,
  ...props
}: ApprovalProps) {
  return (
    <div
      data-slot="approval"
      data-decision={decision}
      className={cn(
        "min-w-0 rounded-lg border-2 border-dashed p-4",
        decision === "allowed" && "border-solid border-success/40 bg-fern-100/50 dark:bg-fern-800/40",
        decision === "denied" && "border-solid border-destructive/40 bg-destructive/[0.06]",
        !decision && "border-warning/50 bg-clay-soft/40",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {reason ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{reason}</p> : null}
          {detail ? (
            <p className="mt-2 overflow-x-auto rounded-md bg-foreground/[0.06] px-2.5 py-1.5 font-mono text-xs whitespace-pre">
              {detail}
            </p>
          ) : null}

          {decision ? (
            <p className="mt-3 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
              {decision === "allowed" ? "Allowed by you" : "Denied by you"}
            </p>
          ) : (
            <div className="mt-3.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={onAllow}>
                Allow once
              </Button>
              <Button size="sm" variant="outline" onClick={onAllowAlways}>
                Always allow
              </Button>
              <Button size="sm" variant="ghost" onClick={onDeny}>
                Deny
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export { Approval }
