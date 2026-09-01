import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/cn.js"

const headingVariants = cva("font-display text-foreground", {
  variants: {
    level: {
      h1: "text-4xl leading-[1.02] tracking-[-0.025em]",
      h2: "text-3xl leading-[1.08] tracking-[-0.02em]",
      h3: "text-2xl leading-tight",
      h4: "text-xl leading-snug",
    },
  },
  defaultVariants: { level: "h2" },
})

type HeadingProps = React.ComponentProps<"h2"> &
  VariantProps<typeof headingVariants> & { as?: "h1" | "h2" | "h3" | "h4" }

function Heading({ className, level, as, ...props }: HeadingProps) {
  const Comp = (as ?? level ?? "h2") as "h2"
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

function Muted({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm leading-relaxed text-muted-foreground", className)} {...props} />
}

export { Heading, Eyebrow, Muted }
