import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const tabsListVariants = cva("inline-flex items-center", {
  variants: {
    variant: {
      /** Pill group on a muted tray. */
      solid: "gap-1 rounded-full bg-muted p-1",
      /** Editorial rule — tabs sit on a hairline, the active one is underscored. */
      underline: "gap-6 border-b border-border",
    },
  },
  defaultVariants: { variant: "solid" },
})

/**
 * The list writes `data-variant` onto itself; triggers read it from their
 * ancestor so a trigger never has to repeat the variant it lives in.
 */
function TabsList({
  className,
  variant = "solid",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        "[[data-variant=solid]_&]:rounded-full [[data-variant=solid]_&]:px-4 [[data-variant=solid]_&]:py-1.5",
        "[[data-variant=solid]_&]:text-muted-foreground",
        "[[data-variant=solid]_&]:data-[state=active]:bg-card [[data-variant=solid]_&]:data-[state=active]:text-foreground",
        "[[data-variant=solid]_&]:data-[state=active]:shadow-paper",
        "[[data-variant=underline]_&]:-mb-px [[data-variant=underline]_&]:border-b-2 [[data-variant=underline]_&]:border-transparent",
        "[[data-variant=underline]_&]:pb-3 [[data-variant=underline]_&]:text-muted-foreground",
        "[[data-variant=underline]_&]:data-[state=active]:border-foreground [[data-variant=underline]_&]:data-[state=active]:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("mt-5 focus-visible:outline-none data-[state=active]:animate-in-fade", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
