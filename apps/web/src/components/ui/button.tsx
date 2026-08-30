import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-[background-color,color,border-color,box-shadow,transform] duration-150",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-45",
    "active:translate-y-px",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-paper hover:bg-fern-700 dark:hover:bg-fern-100",
        accent: "bg-accent text-accent-foreground shadow-paper hover:brightness-95",
        secondary: "bg-secondary text-secondary-foreground hover:bg-paper-400 dark:hover:bg-[#333a26]",
        outline:
          "border border-foreground/25 bg-transparent text-foreground hover:border-foreground/60 hover:bg-foreground/[0.04]",
        ghost: "bg-transparent text-foreground hover:bg-foreground/[0.06]",
        /** Editorial rule-underline link — the house link treatment. */
        link: "h-auto rounded-none p-0 text-foreground underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground",
        destructive: "bg-destructive text-destructive-foreground shadow-paper hover:brightness-95",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-[0.8125rem]",
        md: "h-10 rounded-lg px-4 text-sm",
        lg: "h-12 rounded-lg px-6 text-base",
        icon: "size-10 rounded-lg",
        "icon-sm": "size-8 rounded-md",
      },
      /** Fully rounded pill — used for filters, tags and floating actions. */
      pill: { true: "rounded-full", false: "" },
    },
    compoundVariants: [{ variant: "link", size: ["sm", "md", "lg", "icon", "icon-sm"], class: "h-auto px-0" }],
    defaultVariants: { variant: "primary", size: "md", pill: false },
  },
)

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

function Button({ className, variant, size, pill, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, pill }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
