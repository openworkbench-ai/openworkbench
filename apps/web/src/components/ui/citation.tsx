import { ExternalLink } from "lucide-react"

import { cn } from "@/lib/utils"

/** Superscript reference marker that sits inside a sentence. */
function Citation({
  index,
  className,
  ...props
}: React.ComponentProps<"a"> & { index: number | string }) {
  return (
    <a
      data-slot="citation"
      className={cn(
        "mx-0.5 inline-flex size-4 translate-y-[-0.15em] items-center justify-center rounded-[4px] align-baseline",
        "bg-foreground/[0.08] font-mono text-[0.5625rem] leading-none text-muted-foreground no-underline",
        "transition-colors hover:bg-accent hover:text-accent-foreground",
        className,
      )}
      {...props}
    >
      {index}
    </a>
  )
}

/** The list of what the answer was built from. */
function SourceList({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol data-slot="source-list" className={cn("flex flex-col gap-1.5", className)} {...props} />
}

function Source({
  index,
  title,
  host,
  snippet,
  href,
  className,
  ...props
}: React.ComponentProps<"li"> & {
  index: number | string
  title: React.ReactNode
  host?: React.ReactNode
  snippet?: React.ReactNode
  href?: string
}) {
  return (
    <li data-slot="source" className={cn("min-w-0", className)} {...props}>
      <a
        href={href}
        className={cn(
          "flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2 no-underline",
          "transition-colors hover:border-foreground/30 hover:bg-foreground/[0.02]",
        )}
      >
        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] bg-foreground/[0.08] font-mono text-[0.5625rem] text-muted-foreground">
          {index}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          {snippet ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{snippet}</span> : null}
        </span>
        {host ? (
          <span className="hidden shrink-0 items-center gap-1 font-mono text-[0.625rem] text-muted-foreground sm:flex">
            {host}
            <ExternalLink className="size-2.5" />
          </span>
        ) : null}
      </a>
    </li>
  )
}

export { Citation, SourceList, Source }
