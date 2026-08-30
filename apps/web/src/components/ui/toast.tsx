import { Toaster as Sonner, toast } from "sonner"

import { useTheme } from "@/lib/theme"

/**
 * Toast surface, themed to match the paper palette.
 * Call `toast("…")` from anywhere below this provider.
 */
function Toaster(props: React.ComponentProps<typeof Sonner>) {
  const { theme } = useTheme()

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-lg !border !border-border !bg-card !text-card-foreground !shadow-lift !font-sans",
          title: "!text-sm !font-medium",
          description: "!text-xs !text-muted-foreground",
          actionButton: "!rounded-md !bg-primary !text-primary-foreground !font-medium",
          cancelButton: "!rounded-md !bg-muted !text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
