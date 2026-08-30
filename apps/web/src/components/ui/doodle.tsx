import { cn } from "@/lib/utils"

/**
 * Hand-drawn line marks. One stroke weight, one visual voice — they sit
 * beside headlines the way a printer's ornament sits beside a masthead.
 */
const paths = {
  sprout: (
    <>
      <path d="M24 42V22" />
      <path d="M24 26c-9 0-14-5-14-13 8-1 14 4 14 13Z" />
      <path d="M24 30c8 0 13-5 13-12-8-1-13 4-13 12Z" />
      <path d="M14 42h20" />
    </>
  ),
  sun: (
    <>
      <circle cx="24" cy="24" r="9" />
      <path d="M24 6v5M24 37v5M6 24h5M37 24h5M11 11l3.5 3.5M33.5 33.5 37 37M37 11l-3.5 3.5M14.5 33.5 11 37" />
    </>
  ),
  leaf: (
    <>
      <path d="M11 40C8 24 17 10 39 8c2 21-11 32-28 32Z" />
      <path d="M13 39C20 30 28 21 37 12" />
      <path d="M22 27c4-1 8-1 11 1M19 33c3-4 6-6 10-7" />
    </>
  ),
  cup: (
    <>
      <path d="M11 21h22v11a10 10 0 0 1-10 10h-2a10 10 0 0 1-10-10V21Z" />
      <path d="M33 24h3a5 5 0 0 1 0 10h-3" />
      <path d="M17 14c2-2 0-4 1-6M24 14c2-2 0-4 1-6" />
    </>
  ),
  spark: (
    <>
      <path d="M24 5c1.5 11 6.5 16 17 18-10.5 2-15.5 7-17 18-1.5-11-6.5-16-17-18 10.5-2 15.5-7 17-18Z" />
      <path d="M39 33c.6 3.5 2 5 5 5.5-3 .6-4.4 2-5 5.5-.6-3.5-2-5-5-5.5 3-.6 4.4-2 5-5.5Z" />
    </>
  ),
  moon: (
    <>
      <path d="M33 30A15 15 0 0 1 18 9a16 16 0 1 0 20 20 15 15 0 0 1-5 1Z" />
      <path d="M36 8v6M33 11h6" />
    </>
  ),
  bird: (
    <>
      <path d="M6 28c6-9 14-13 24-12 3 .3 6 1.6 9 4" />
      <path d="M12 25c5 5 12 7 20 6" />
      <path d="M33 20c1-3 3-5 6-5M30 33l-3 8M22 35l-2 7" />
    </>
  ),
  parcel: (
    <>
      <path d="M8 17 24 9l16 8v16l-16 8-16-8V17Z" />
      <path d="M8 17l16 8 16-8M24 25v16" />
      <path d="M20 32c3 3 5 3 8 0" />
    </>
  ),
  note: (
    <>
      <rect x="6" y="14" width="36" height="21" rx="3" />
      <circle cx="24" cy="24" r="5.5" />
      <path d="M12 20v8M36 20v8" />
    </>
  ),
  flower: (
    <>
      <circle cx="24" cy="20" r="4" />
      <path d="M24 16c0-6 8-6 6 1M28 20c6-2 8 6 1 5M26 26c3 5-4 8-6 2M20 24c-6 2-6-7 0-5" />
      <path d="M24 30v12M24 36c-4 0-7-2-8-5M24 38c4 0 7-2 8-5" />
    </>
  ),
  eye: (
    <>
      <path d="M4 24c6-8 12-12 20-12s14 4 20 12c-6 8-12 12-20 12S10 32 4 24Z" />
      <circle cx="24" cy="24" r="6" />
      <path d="M18 10l-2-5M30 10l2-5" />
    </>
  ),
  hand: (
    <>
      <path d="M17 27V11a3 3 0 0 1 6 0v12" />
      <path d="M23 22v-4a3 3 0 0 1 6 0v6" />
      <path d="M29 25v-2a3 3 0 0 1 6 0v13c0 6-4 10-10 10h-3c-5 0-8-3-10-8l-4-9a3 3 0 0 1 5-3l4 5" />
    </>
  ),
} as const

export type DoodleName = keyof typeof paths
export const doodleNames = Object.keys(paths) as DoodleName[]

interface DoodleProps extends React.ComponentProps<"svg"> {
  name: DoodleName
}

function Doodle({ name, className, ...props }: DoodleProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-12", className)}
      {...props}
    >
      {paths[name]}
    </svg>
  )
}

export { Doodle }
