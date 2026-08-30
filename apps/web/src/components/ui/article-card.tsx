import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Doodle, type DoodleName } from "@/components/ui/doodle"

const articleCardVariants = cva(
  "group relative flex aspect-[3/4] w-full flex-col justify-between rounded-2xl p-6 text-left transition-[transform,box-shadow] duration-300",
  {
    variants: {
      tone: {
        paper: "bg-paper-50 text-fern-800 border border-foreground/10",
        blush: "bg-blush-soft text-fern-800",
        terracotta: "bg-terracotta text-paper-50",
        clay: "bg-clay-soft text-fern-800",
        ocean: "bg-ocean-soft text-fern-800",
        ink: "bg-fern-700 text-paper-50",
      },
      interactive: { true: "cursor-pointer hover:-translate-y-1.5 hover:shadow-lift", false: "" },
    },
    defaultVariants: { tone: "paper", interactive: true },
  },
)

interface ArticleCardProps
  extends Omit<React.ComponentProps<"article">, "title">,
    VariantProps<typeof articleCardVariants> {
  title: React.ReactNode
  author?: React.ReactNode
  day?: string | number
  month?: string
  doodle?: DoodleName
}

/**
 * Dated editorial card — illustration and date up top, headline anchored to
 * the bottom edge. Stacks well in an overlapping grid.
 */
function ArticleCard({
  className,
  tone,
  interactive,
  title,
  author,
  day,
  month,
  doodle = "sprout",
  ...props
}: ArticleCardProps) {
  return (
    <article className={cn(articleCardVariants({ tone, interactive }), className)} {...props}>
      <div className="flex items-start justify-between gap-4">
        <Doodle name={doodle} className="size-14 transition-transform duration-300 group-hover:-rotate-6" />
        {day ? (
          <div className="text-right leading-none">
            <div className="font-sans text-3xl font-medium tracking-tight">{day}</div>
            {month ? (
              <div className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.14em] opacity-70">{month}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="font-sans text-xl leading-[1.15] font-semibold tracking-[-0.015em] text-balance">{title}</h3>
        {author ? (
          <p className="mt-4 font-mono text-[0.625rem] uppercase tracking-[0.14em] opacity-75">{author}</p>
        ) : null}
      </div>
    </article>
  )
}

export { ArticleCard, articleCardVariants }
