import { cn } from "@/lib/utils"

/** Blinking block caret that trails text still being generated. */
function StreamingCaret({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="streaming-caret"
      aria-hidden="true"
      className={cn(
        "ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.12em] bg-accent align-baseline",
        "animate-caret motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  )
}

/** Three-dot "working on it" indicator. */
function TypingDots({ className, label = "Assistant is replying", ...props }: React.ComponentProps<"span"> & { label?: string }) {
  return (
    <span data-slot="typing-dots" role="status" aria-label={label} className={cn("inline-flex items-center gap-1", className)} {...props}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-current animate-dot motion-reduce:animate-none"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  )
}

/** Text with a light sweeping across it — for labels that describe live work. */
function ShimmerText({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="shimmer-text" className={cn("shimmer-text motion-reduce:animate-none", className)} {...props} />
}

export { StreamingCaret, TypingDots, ShimmerText }
