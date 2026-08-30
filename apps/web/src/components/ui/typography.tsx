import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const headingVariants = cva("font-display text-foreground", {
  variants: {
    level: {
      display: "text-5xl leading-[0.95] tracking-[-0.03em] sm:text-6xl md:text-7xl",
      h1: "text-4xl leading-[1.02] tracking-[-0.025em] sm:text-5xl",
      h2: "text-3xl leading-[1.08] tracking-[-0.02em] sm:text-4xl",
      h3: "text-2xl leading-tight",
      h4: "text-xl leading-snug",
    },
  },
  defaultVariants: { level: "h2" },
})

type HeadingProps = React.ComponentProps<"h2"> &
  VariantProps<typeof headingVariants> & { as?: "h1" | "h2" | "h3" | "h4" | "p" | "span" }

function Heading({ className, level, as, ...props }: HeadingProps) {
  const Comp = (as ?? (level === "display" ? "h1" : level === undefined ? "h2" : level === "h1" ? "h1" : level)) as "h2"
  return <Comp className={cn(headingVariants({ level }), className)} {...props} />
}

/** Small uppercase mono kicker that sits above headings and beside rules. */
function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="eyebrow"
      className={cn("font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-muted-foreground", className)}
      {...props}
    />
  )
}

function Lead({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-lg leading-relaxed text-muted-foreground sm:text-xl", className)} {...props} />
}

function Muted({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm leading-relaxed text-muted-foreground", className)} {...props} />
}

function Code({ className, ...props }: React.ComponentProps<"code">) {
  return (
    <code
      className={cn("rounded-[5px] bg-foreground/[0.07] px-1.5 py-0.5 font-mono text-[0.8125em]", className)}
      {...props}
    />
  )
}

/**
 * Long-form body copy with a printed drop cap on the opening paragraph.
 */
function Prose({ className, dropCap = false, ...props }: React.ComponentProps<"div"> & { dropCap?: boolean }) {
  return (
    <div
      data-slot="prose"
      className={cn(
        "max-w-[62ch] text-[0.9375rem] leading-[1.75] text-foreground/85",
        "[&_p+p]:mt-4 [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-foreground/40",
        dropCap &&
          "[&>p:first-of-type::first-letter]:float-left [&>p:first-of-type::first-letter]:mt-1 [&>p:first-of-type::first-letter]:mr-2 [&>p:first-of-type::first-letter]:font-display [&>p:first-of-type::first-letter]:text-[3.5rem] [&>p:first-of-type::first-letter]:leading-[0.8] [&>p:first-of-type::first-letter]:font-semibold",
        className,
      )}
      {...props}
    />
  )
}

/** Pull quote set in the display serif, hung off a vertical rule. */
function Quote({ className, cite, children, ...props }: React.ComponentProps<"blockquote"> & { cite?: string }) {
  return (
    <blockquote className={cn("border-l-2 border-accent pl-5", className)} {...props}>
      <p className="font-display text-xl leading-snug text-foreground sm:text-2xl">{children}</p>
      {cite ? <footer className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">{cite}</footer> : null}
    </blockquote>
  )
}

export { Heading, Eyebrow, Lead, Muted, Code, Prose, Quote, headingVariants }
