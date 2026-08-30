import { useState } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Doodle } from "@/components/ui/doodle"
import { ShimmerText } from "@/components/ui/streaming"

interface ThinkingProps extends React.ComponentProps<"div"> {
  /** Reasoning is still arriving — shows a live label instead of a duration. */
  streaming?: boolean
  /** Seconds spent reasoning, shown once finished. */
  duration?: number
  defaultOpen?: boolean
  label?: string
}

/**
 * Collapsible reasoning trace. Closed by default once finished, because the
 * conclusion matters more than the working — but the working stays available.
 */
function Thinking({
  streaming = false,
  duration,
  defaultOpen = false,
  label,
  className,
  children,
  ...props
}: ThinkingProps) {
  const [open, setOpen] = useState(defaultOpen)

  const heading =
    label ?? (streaming ? "Thinking" : duration != null ? `Thought for ${duration}s` : "Thought process")

  return (
    <div data-slot="thinking" data-streaming={streaming || undefined} className={cn("w-full", className)} {...props}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "group inline-flex items-center gap-2 rounded-md py-1 pr-2 text-sm",
          "text-muted-foreground transition-colors hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        )}
      >
        <Doodle
          name="spark"
          className={cn("size-4 text-accent", streaming && "animate-pulse motion-reduce:animate-none")}
        />
        {streaming ? <ShimmerText className="font-medium">{heading}</ShimmerText> : <span>{heading}</span>}
        <ChevronRight
          className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="mt-1 border-l border-dashed border-foreground/25 pt-1 pb-1 pl-4 animate-in-fade">
          <div className="max-w-[62ch] text-[0.8125rem] leading-[1.7] text-muted-foreground italic [&_p+p]:mt-3">
            {children}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export { Thinking }
