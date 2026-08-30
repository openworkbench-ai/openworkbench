import { cn } from "@/lib/utils"

/** Slim breadcrumb bar shared by every screen — a label on the left, controls on the right. */
function PageHeader({
  breadcrumb,
  className,
  children,
}: {
  breadcrumb: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div className={cn("flex items-center gap-3 border-b border-border px-6 py-3.5 sm:px-10", className)}>
      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
        {breadcrumb}
      </span>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  )
}

export { PageHeader }
