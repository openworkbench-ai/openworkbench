import { useEffect, useState } from "react"

/**
 * Same as `useState`, but the value round-trips through `sessionStorage` under `key` --
 * survives a page reload or an unmount/remount within the tab (e.g. a route change or a
 * dev-server full reload), but resets on tab close. Good enough for v0.1 chat state; a real
 * history endpoint is the next step if we need it to survive a closed tab.
 */
export function usePersistedState<T>(key: string, initial: T, sanitize?: (value: T) => T): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key)
      if (!raw) return initial
      const parsed = JSON.parse(raw) as T
      return sanitize ? sanitize(parsed) : parsed
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state))
    } catch {
      // storage disabled or quota exceeded -- fall back to in-memory only
    }
  }, [key, state])

  return [state, setState]
}
