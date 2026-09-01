import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/cn.js"

const cardVariants = cva("flex flex-col text-card-foreground", {
  variants: {
    variant: {
      paper: "rounded-xl border bg-card shadow-paper",
      outline: "rounded-xl border border-foreground/15 bg-transparent",
      ink: "rounded-xl border-transparent bg-primary text-primary-foreground shadow-lift",
    },
  },
  defaultVariants: { variant: "paper" },
})

function Card({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ variant }), className)} {...props} />
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1.5 p-6", className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 data-slot="card-title" className={cn("font-display text-xl leading-tight", className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p data-slot="card-description" className={cn("text-sm leading-relaxed text-muted-foreground", className)} {...props} />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-6 pt-0", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("mt-auto flex items-center gap-3 p-6 pt-0", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
