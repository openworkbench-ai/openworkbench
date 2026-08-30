import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

interface FieldProps extends React.ComponentProps<"div"> {
  label?: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
  disabled?: boolean
}

/**
 * Labelled form row: label, control, and one line of hint or error text.
 * Keeps spacing and the hint/error swap consistent across every form.
 */
function Field({ label, htmlFor, hint, error, disabled, className, children, ...props }: FieldProps) {
  return (
    <div
      data-slot="field"
      data-disabled={disabled || undefined}
      className={cn("group/field flex flex-col gap-2", className)}
      {...props}
    >
      {label ? <Label htmlFor={htmlFor}>{label}</Label> : null}
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export { Field }
