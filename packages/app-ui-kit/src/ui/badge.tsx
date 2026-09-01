import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/cn.js"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[0.6875rem] uppercase tracking-[0.12em]",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        outline: "border-foreground/25 bg-transparent text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        accent: "border-transparent bg-app-accent text-app-accent-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
