---
name: ui
description: How to write ui/components/<Name>.tsx for a tool's rendered result — resolution, @openworkbench/app-ui-kit primitives, generated entity types, and validation. Read this before writing or editing any app's UI component.
---

# UI components

By default a tool's result renders as raw JSON in a generic tool-call
card. For a tool whose result deserves a real look — not internal
bookkeeping (see the `app-design` skill for when that's actually true) —
write a React component and reference it from that tool:

```json
{ "id": "tool_get_workout", "name": "get_workout", "steps": [...],
  "ui": { "component": "Workout" } }
```

This resolves to `ui/components/Workout.tsx`, built into a self-contained
MCP Apps resource and served to whatever client is chatting — Open
Workbench's own chat renders it in a sandboxed iframe, and so does any
other MCP-Apps-capable host. Several tools can share one component (e.g.
`create_workout` and `get_workout` both rendering via `Workout.tsx`) by
setting the same `ui.component` on each.

## Writing the component

- Default-export exactly one function component per file.
- Import presentational primitives from `@openworkbench/app-ui-kit`:
  `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`,
  `CardFooter`, `Badge`, `Stat`, `Heading`, `Eyebrow`, `Muted`, `Table`,
  `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`. Use
  Tailwind utility classes for anything else — the same design language
  as the rest of Open Workbench, so a component reads as belonging to the
  product, not a random one-off page. An accent-colored `Badge`
  (`variant="accent"`, also `"outline"`/`"muted"`/`"destructive"`) or a
  `Stat` block (`value`/`label`/optional `trend`) are usually enough to
  make a card feel like *this app's* own look — seeded automatically from
  `manifest.json`'s `app.color`, so don't hardcode colors yourself.
- Its props are that tool's result row. Import the matching interface
  from `../generated/entities.d.ts` instead of guessing field names:

  ```tsx
  import { Card, CardHeader, CardTitle, CardContent, Badge } from "@openworkbench/app-ui-kit"
  import type { Workout } from "../generated/entities.d.ts"

  export default function Workout(props: Partial<Workout>) {
    return (
      <Card>
        <CardHeader><CardTitle>{props.name ?? "Untitled workout"}</CardTitle></CardHeader>
        <CardContent><Badge variant="accent">{props.status ?? "planned"}</Badge></CardContent>
      </Card>
    )
  }
  ```
- Type props as `Partial<Entity>`, not `Entity` — a `list` tool's rows
  and a single-row tool's result aren't guaranteed to carry identical
  shapes, and props arrive named exactly as the manifest's fields, plus
  the platform's own `id`/`created_at`/`updated_at`.
- Don't write App-bridge/connection boilerplate — that's fixed infra
  (`@openworkbench/app-ui-kit`'s shell) wired in automatically when
  `validate_app`/`present_app` build the component. You only ever write
  the presentational component itself.
- Components are presentational app views, not standalone applications —
  no routing, no fetching, no state beyond what its own props carry.

## `ui/generated/entities.d.ts`

**Never edit this file by hand.** `validate_app` (re)writes it from your
current manifest's entities every time you call it. If a type you expect
isn't there, your manifest doesn't declare that field yet — fix the
manifest, then re-validate to regenerate the types, then fix the
component.

## Validation

`validate_app` type-checks every `ui/components/*.tsx` file against the
real generated entity types (and the design kit's own types) and reports
the exact compiler error if something doesn't line up — a wrong prop
name, a missing import, whatever. Treat that the same way you treat a
manifest validation error: fix it and re-validate before presenting.
Reasoning alone ("this prop should exist") is not a substitute for
actually validating.
