import { useLayoutEffect, useRef } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/use-copy"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Doodle } from "@/components/ui/doodle"

interface ConversationProps extends React.ComponentProps<"div"> {
  /**
   * Follow new content down, the way a chat log should — but only while the
   * reader is already at the bottom, so scrolling back up is never fought.
   */
  stickToBottom?: boolean
}

/** Scroll region that holds a transcript. */
function Conversation({ className, stickToBottom = false, onScroll, ...props }: ConversationProps) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !stickToBottom || !pinned.current) return
    el.scrollTop = el.scrollHeight
  })

  return (
    <div
      ref={ref}
      data-slot="conversation"
      onScroll={(event) => {
        const el = event.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        onScroll?.(event)
      }}
      className={cn("flex min-w-0 flex-col gap-6 overflow-y-auto overscroll-contain", className)}
      {...props}
    />
  )
}

const messageVariants = cva("flex min-w-0 gap-3", {
  variants: {
    role: {
      /** Person's turn — a bubble, hung to the right. */
      user: "flex-row-reverse",
      /** Agent's turn — full measure, no bubble, so long answers read as prose. */
      assistant: "flex-row",
      /** Rail note: a state change, not something anyone said. */
      system: "flex-row justify-center",
    },
  },
  defaultVariants: { role: "assistant" },
})

interface MessageProps
  extends Omit<React.ComponentProps<"div">, "role">,
    VariantProps<typeof messageVariants> {}

function Message({ className, role = "assistant", ...props }: MessageProps) {
  return (
    <div
      data-slot="message"
      data-role={role}
      className={cn(messageVariants({ role }), className)}
      {...props}
    />
  )
}

/** Round mark identifying the speaker; the agent gets a drawn one. */
function MessageAvatar({
  role = "assistant",
  initials,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "role"> & { role?: "user" | "assistant"; initials?: string }) {
  if (role === "assistant") {
    return (
      <div
        data-slot="message-avatar"
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full border border-foreground/15 bg-fern-100 text-fern-700 dark:bg-fern-800 dark:text-fern-200",
          className,
        )}
        {...props}
      >
        <Doodle name="sprout" className="size-4.5" />
      </div>
    )
  }

  return (
    <Avatar size="sm" data-slot="message-avatar" className={cn("shrink-0", className)} {...props}>
      <AvatarFallback className="bg-clay-soft font-mono text-[0.625rem]">{initials ?? "You"}</AvatarFallback>
    </Avatar>
  )
}

const messageContentVariants = cva("min-w-0 text-[0.9375rem] leading-[1.7] [&_p+p]:mt-3", {
  variants: {
    role: {
      user: "max-w-[80%] rounded-2xl rounded-tr-sm bg-secondary px-4 py-2.5 text-secondary-foreground",
      assistant: "flex-1 text-foreground",
      system:
        "rounded-full bg-muted px-3 py-1 text-center font-mono text-[0.625rem] tracking-[0.12em] text-muted-foreground uppercase",
    },
  },
  defaultVariants: { role: "assistant" },
})

function MessageContent({
  className,
  role = "assistant",
  ...props
}: Omit<React.ComponentProps<"div">, "role"> & VariantProps<typeof messageContentVariants>) {
  return (
    <div data-slot="message-content" className={cn(messageContentVariants({ role }), className)} {...props} />
  )
}

/** Timestamp / model line, tucked under a turn. */
function MessageMeta({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="message-meta"
      className={cn("mt-2 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Hover-revealed row of per-message actions. */
function MessageActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        "mt-2 flex items-center gap-0.5 text-muted-foreground",
        "opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

function MessageAction({
  label,
  icon: Icon,
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { label: string; icon: React.ElementType; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid size-7 place-items-center rounded-md transition-colors",
        "hover:bg-foreground/[0.06] hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        active && "text-foreground",
        className,
      )}
      {...props}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

/** The usual three: copy, regenerate, rate. */
function MessageActionsDefault({
  content,
  onRegenerate,
  className,
}: {
  content: string
  onRegenerate?: () => void
  className?: string
}) {
  const { copied, copy } = useCopy()
  return (
    <MessageActions className={className}>
      <MessageAction label={copied ? "Copied" : "Copy"} icon={copied ? Check : Copy} onClick={() => copy(content)} />
      {onRegenerate ? <MessageAction label="Regenerate" icon={RefreshCw} onClick={onRegenerate} /> : null}
      <MessageAction label="Good response" icon={ThumbsUp} />
      <MessageAction label="Bad response" icon={ThumbsDown} />
    </MessageActions>
  )
}

export {
  Conversation,
  Message,
  MessageAvatar,
  MessageContent,
  MessageMeta,
  MessageActions,
  MessageAction,
  MessageActionsDefault,
  messageVariants,
  messageContentVariants,
}
