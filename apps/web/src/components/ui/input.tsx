import { cn } from "@/lib/utils"

const fieldBase = [
  "w-full bg-card text-foreground placeholder:text-muted-foreground/70",
  "border border-input rounded-lg",
  "transition-[border-color,box-shadow] duration-150",
  "hover:border-foreground/35",
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
].join(" ")

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldBase,
        "h-10 px-3 py-2 text-sm",
        "file:mr-3 file:border-0 file:bg-transparent file:font-mono file:text-xs file:uppercase file:tracking-wider",
        className,
      )}
      {...props}
    />
  )
}

export { Input, fieldBase }
