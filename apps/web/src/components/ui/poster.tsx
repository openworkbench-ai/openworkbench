import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const posterVariants = cva(
  "relative flex aspect-[3/4] flex-col justify-between overflow-hidden p-6 sm:p-8 transition-shadow",
  {
    variants: {
      tone: {
        cream: "bg-paper-50 text-fern-800",
        ink: "bg-fern-700 text-paper-50",
        terracotta: "bg-terracotta text-paper-50",
        blush: "bg-blush-soft text-fern-800",
        clay: "bg-clay-soft text-fern-800",
        ocean: "bg-ocean-soft text-fern-800",
      },
      bordered: { true: "border border-foreground/10", false: "" },
    },
    defaultVariants: { tone: "cream", bordered: true },
  },
)

interface PosterProps extends React.ComponentProps<"article">, VariantProps<typeof posterVariants> {
  /** Wordmark printed above the top rule. */
  wordmark?: React.ReactNode
  /** Fine print below the bottom rule. */
  footer?: React.ReactNode
  /** Right-hand fine print, opposite `footer`. */
  footerMeta?: React.ReactNode
}

/**
 * A printed poster panel: masthead, hairline rules top and bottom, and a
 * statement set large in the display serif between them.
 */
function Poster({
  className,
  tone,
  bordered,
  wordmark,
  footer,
  footerMeta,
  children,
  ...props
}: PosterProps) {
  return (
    <article className={cn(posterVariants({ tone, bordered }), "shadow-paper", className)} {...props}>
      {wordmark ? (
        <header className="border-b border-current/35 pb-3 text-center font-display text-base font-semibold tracking-tight">
          {wordmark}
        </header>
      ) : (
        <span />
      )}

      <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">{children}</div>

      {footer || footerMeta ? (
        <footer className="flex items-center justify-between gap-3 border-t border-current/35 pt-3 font-mono text-[0.5625rem] uppercase tracking-[0.16em] sm:text-[0.625rem]">
          <span>{footer}</span>
          <span className="opacity-80">{footerMeta}</span>
        </footer>
      ) : null}
    </article>
  )
}

/** Oversized statement type for poster bodies. */
function PosterStatement({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("font-display text-[clamp(1.5rem,4.2vw,2.5rem)] leading-[1.05] tracking-[-0.02em]", className)}
      {...props}
    />
  )
}

export { Poster, PosterStatement, posterVariants }
