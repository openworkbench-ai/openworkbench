import { Children } from "react"

import { cn } from "@/lib/utils"

interface MarqueeProps extends React.ComponentProps<"div"> {
  /** Seconds for one full pass. */
  speed?: number
}

/**
 * Endlessly scrolling strip of items, doubled so the loop is seamless.
 * Respects `prefers-reduced-motion` by holding still.
 */
function Marquee({ className, children, speed = 34, ...props }: MarqueeProps) {
  const items = Children.toArray(children)

  return (
    <div
      data-slot="marquee"
      className={cn("group relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_6%,black_94%,transparent)]", className)}
      {...props}
    >
      {[0, 1].map((copy) => (
        <div
          key={copy}
          aria-hidden={copy === 1}
          className="flex shrink-0 items-center gap-10 pr-10 animate-marquee motion-reduce:animate-none"
          style={{ animationDuration: `${speed}s` }}
        >
          {items.map((item, i) => (
            <span key={i} className="flex shrink-0 items-center gap-10">
              {item}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

export { Marquee }
