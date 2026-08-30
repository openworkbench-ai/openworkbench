import { cva, type VariantProps } from "class-variance-authority"
import { Check, CircleDashed, Loader2, X } from "lucide-react"

import { cn } from "@/lib/utils"

type TaskState = "pending" | "active" | "done" | "failed"

const marker: Record<TaskState, { icon: React.ElementType; className: string }> = {
  pending: { icon: CircleDashed, className: "text-muted-foreground/70" },
  active: { icon: Loader2, className: "text-ocean" },
  done: { icon: Check, className: "text-success" },
  failed: { icon: X, className: "text-destructive" },
}

const taskItemVariants = cva("flex items-start gap-2.5 py-1.5 text-sm", {
  variants: {
    state: {
      pending: "text-muted-foreground",
      active: "text-foreground",
      done: "text-muted-foreground line-through decoration-foreground/25",
      failed: "text-foreground",
    },
  },
  defaultVariants: { state: "pending" },
})

/** The agent's plan — what it intends to do, and where it has got to. */
function TaskList({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol data-slot="task-list" className={cn("flex flex-col", className)} {...props} />
}

function TaskItem({
  state = "pending",
  className,
  children,
  ...props
}: React.ComponentProps<"li"> & VariantProps<typeof taskItemVariants>) {
  const { icon: Icon, className: iconClass } = marker[state ?? "pending"]
  return (
    <li data-slot="task-item" data-state={state} className={cn(taskItemVariants({ state }), className)} {...props}>
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", iconClass, state === "active" && "animate-spin motion-reduce:animate-none")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

export { TaskList, TaskItem, taskItemVariants, type TaskState }
