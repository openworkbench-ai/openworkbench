import * as LabelPrimitive from "@radix-ui/react-label"

import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground select-none",
        "group-data-[disabled=true]/field:opacity-50 peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Label }
