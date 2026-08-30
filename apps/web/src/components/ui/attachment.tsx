import { File, FileText, Image as ImageIcon, X } from "lucide-react"

import { cn } from "@/lib/utils"

type AttachmentKind = "file" | "image" | "text"

const icons: Record<AttachmentKind, React.ElementType> = {
  file: File,
  image: ImageIcon,
  text: FileText,
}

/** Chip for something handed to the agent alongside a prompt. */
function Attachment({
  name,
  size,
  kind = "file",
  onRemove,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  name: string
  size?: string
  kind?: AttachmentKind
  onRemove?: () => void
}) {
  const Icon = icons[kind]
  return (
    <div
      data-slot="attachment"
      className={cn(
        "inline-flex min-w-0 max-w-56 items-center gap-2 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-2.5",
        className,
      )}
      {...props}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
      {size ? <span className="shrink-0 font-mono text-[0.5625rem] text-muted-foreground">{size}</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="grid size-5 shrink-0 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

function AttachmentList({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-list" className={cn("flex flex-wrap gap-2", className)} {...props} />
}

export { Attachment, AttachmentList }
