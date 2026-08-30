import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/use-copy"

interface CodeBlockProps extends Omit<React.ComponentProps<"div">, "children"> {
  code: string
  language?: string
  filename?: string
  copyable?: boolean
}

/**
 * Fenced code with a mono masthead and a copy affordance. Deliberately
 * unhighlighted — ink on paper, the way a listing looks in print.
 */
function CodeBlock({ code, language, filename, copyable = true, className, ...props }: CodeBlockProps) {
  const { copied, copy } = useCopy()

  return (
    <div
      data-slot="code-block"
      className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-background", className)}
      {...props}
    >
      {filename || language || copyable ? (
        <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
          <span className="truncate font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
            {filename ?? language}
          </span>
          {copyable ? (
            <button
              type="button"
              onClick={() => copy(code)}
              className={cn(
                "ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.12em]",
                "text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
              )}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      ) : null}

      <pre className="overflow-x-auto p-3 font-mono text-xs leading-[1.7]">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export { CodeBlock }
