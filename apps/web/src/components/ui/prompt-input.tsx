import { useRef } from "react"
import { ArrowUp, Square } from "lucide-react"

import { cn } from "@/lib/utils"
import { useAutosizeTextarea } from "@/hooks/use-autosize-textarea"
import { Button } from "@/components/ui/button"

/** The composer shell: textarea on top, controls along the bottom edge. */
function PromptInput({ className, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      data-slot="prompt-input"
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-2xl border border-input bg-card p-2.5 shadow-paper",
        "transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
        className,
      )}
      {...props}
    />
  )
}

interface PromptInputTextareaProps extends React.ComponentProps<"textarea"> {
  value: string
  /** Fires on Enter without Shift. */
  onSubmitMessage?: () => void
  maxHeight?: number
}

function PromptInputTextarea({
  className,
  value,
  onSubmitMessage,
  onKeyDown,
  maxHeight = 220,
  ...props
}: PromptInputTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(ref, value, maxHeight)

  return (
    <textarea
      ref={ref}
      data-slot="prompt-input-textarea"
      rows={1}
      value={value}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          onSubmitMessage?.()
        }
      }}
      className={cn(
        "w-full resize-none bg-transparent px-2 py-1.5 text-[0.9375rem] leading-relaxed",
        "placeholder:text-muted-foreground/70 focus:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

/** Bottom rail of the composer — model picker, mode toggles, send. */
function PromptInputToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="prompt-input-toolbar"
      className={cn("flex items-center gap-1.5", className)}
      {...props}
    />
  )
}

/** Small square control for the toolbar (attach, mic, tools). */
function PromptInputAction({
  label,
  icon: Icon,
  className,
  ...props
}: React.ComponentProps<"button"> & { label: string; icon: React.ElementType }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors",
        "hover:bg-foreground/[0.06] hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <Icon className="size-4" />
    </button>
  )
}

/**
 * Send button that becomes a stop button while the agent is generating —
 * one control, because there is only ever one thing to do here.
 */
function PromptInputSend({
  streaming,
  onStop,
  disabled,
  className,
  ...props
}: React.ComponentProps<"button"> & { streaming?: boolean; onStop?: () => void }) {
  if (streaming) {
    return (
      <Button
        type="button"
        size="icon-sm"
        pill
        variant="secondary"
        aria-label="Stop generating"
        onClick={onStop}
        className={cn("ml-auto", className)}
      >
        <Square className="size-3 fill-current" />
      </Button>
    )
  }

  return (
    <Button
      type="submit"
      size="icon-sm"
      pill
      aria-label="Send message"
      disabled={disabled}
      className={cn("ml-auto", className)}
      {...props}
    >
      <ArrowUp />
    </Button>
  )
}

/** Tappable prompt starters shown above an empty composer. */
function Suggestions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="suggestions" className={cn("flex flex-wrap gap-2", className)} {...props} />
}

function Suggestion({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="suggestion"
      className={cn(
        "rounded-full border border-border bg-card px-3 py-1.5 text-left text-xs text-muted-foreground",
        "transition-colors hover:border-foreground/30 hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  )
}

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputAction,
  PromptInputSend,
  Suggestions,
  Suggestion,
}
