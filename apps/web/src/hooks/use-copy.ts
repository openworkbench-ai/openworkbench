import { useCallback, useEffect, useRef, useState } from "react"

/** Copies text to the clipboard and reports success for a short beat. */
export function useCopy(resetAfter = 1800) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        return false
      }
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), resetAfter)
      return true
    },
    [resetAfter],
  )

  return { copied, copy }
}
