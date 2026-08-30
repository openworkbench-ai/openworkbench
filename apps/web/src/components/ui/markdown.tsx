import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { CodeBlock } from "@/components/ui/code-block"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Code, Quote } from "@/components/ui/typography"

function textContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textContent).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textContent(node.props.children)
  return ""
}

/** Message-scaled headings — a chat turn isn't a doc page, so these stay modest. */
const components: Components = {
  h1: ({ children }) => <p className="mt-4 font-display text-lg font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mt-4 font-display text-base font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mt-3 font-display text-[0.9375rem] font-semibold first:mt-0">{children}</p>,
  h4: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  p: ({ children }) => <p className="mt-3 first:mt-0">{children}</p>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mt-3 list-disc space-y-1 pl-5 marker:text-muted-foreground first:mt-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-3 list-decimal space-y-1 pl-5 marker:text-muted-foreground first:mt-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-[1.7]">{children}</li>,
  blockquote: ({ children }) => <Quote className="my-4 text-base first:mt-0">{children}</Quote>,
  hr: () => <hr className="my-6 border-foreground/20" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ className, children }) => {
    if (!className?.startsWith("language-")) return <Code>{children}</Code>
    return (
      <CodeBlock
        className="mt-3 mb-3 first:mt-0"
        language={className.replace("language-", "")}
        code={textContent(children).replace(/\n$/, "")}
      />
    )
  },
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => <Table className="mt-4 mb-4 first:mt-0">{children}</Table>,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
}

/** Renders assistant prose as formatted markdown instead of raw `**text**`/`##` syntax. */
function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export { Markdown }
