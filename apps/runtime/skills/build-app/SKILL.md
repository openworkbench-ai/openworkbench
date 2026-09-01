---
name: build-app
description: Author a new Open Workbench app (manifest, optional skills, optional seed data) in the scratch workspace, always clarifying open decisions with the user up front, then validate it against the engine and present it for the user's own install. Use whenever the user wants to create, build, or set up a new app.
---

# Build a Open Workbench app

You are drafting a **catalog app**: a declarative `manifest.json` the engine
turns into a working CRUD API, MCP tool server, and SQLite database — no
code, no process. You work with your normal file tools (read/write/edit/ls/
grep/find) directly in your workspace; `validate_app` and `commit_app` are
the only two tools that talk to the engine.

## File layout

For an app with id `<id>`, produce this under your workspace root:

```
<id>/manifest.json        required — the app itself
<id>/skills/<name>/SKILL.md   optional, zero or more — agent-facing docs for this app's own tools
<id>/data/<entity>.json    optional, zero or more — starter rows, one file per entity
<id>/ui/components/<Name>.tsx   optional, zero or more — a tool's rendered result, see "UI components" below
<id>/ui/generated/entities.d.ts   written for you by validate_app — entity prop types, don't edit
```

Skills, seed data, and UI components are all entirely optional — plenty of
apps need none of them. Seed data only makes sense for entities you've
actually declared, and is only applied the *first* time an app is installed
(a fresh database), so don't rely on it for anything beyond initial demo/
starter content.

## The manifest

```json
{
  "app": { "id": "todo", "name": "Todo", "description": "...", "emoji": "✅", "color": "#d0ab25", "version": 1 },
  "entities": [ ... ],
  "tools": [ ... ]
}
```

- `entities` is **required and must have at least one entry** — there is no
  such thing as a catalog app with zero entities. (If what the user actually
  wants is a pure skill/instructions bundle with no data model at all, that's
  a different, simpler kind of app outside this skill's scope — say so
  rather than forcing an empty entity into existence.)
- Every id (`app.id`, an entity's `id`, a field's `id`, a tool's `id`) must
  match `^[a-z][a-z0-9_]*$` — lowercase, starts with a letter, digits/
  underscores after. Entity/field/tool **names** follow the same pattern.
  Convention: `ent_<name>`, `fld_<entity>_<name>`, `tool_<name>` — pick ids
  that read as what they are, since you'll cross-reference them by id.
- Never declare a field named `id`, `created_at`, or `updated_at` — the
  platform adds these automatically to every entity.
- `tools` are needed for the agent to interact with the app. Declare single CRUD operations or complex operations when the user's workflow needs an
  atomic operation (e.g. "create a plan and its first workout in one
  call")

### Field types

One of `text`, `integer`, `real`, `boolean`, `datetime`, `enum`, `reference`.
Every field needs `id`, `name`, `type`; `required` and (except boolean/
datetime) `default` are optional on all of them.

- `text`: `min`/`max` (string length).
- `integer` / `real`: `min`/`max` (value bounds).
- `boolean`: no extra properties.
- `datetime`: no extra properties (string default, ISO-ish).
- `enum`: **requires** `values` (a non-empty array of strings); `default`
  must be one of them.
- `reference`: **requires** `target` (another entity's `id` — must exist in
  this same manifest); optional `onDelete`: `set_null` | `restrict` |
  `cascade`.

### Tools

A tool is `{ id, name, description?, params?, steps }`. `params` are fields
(same shape as entity fields) the caller supplies. `steps` is an ordered,
non-branching sequence of CRUD operations against this app's own entities —
`op` is one of `create`/`read`/`update`/`delete`/`list`; `create`/`list`
never take `rowId`, `read`/`update`/`delete` require it; `set` (create/
update) and `filter` (list) are `{ field: value }` maps where a value is
either a literal or a reference string:

- `$params.<name>` — a value the caller passed in.
- `$steps.<id>.<field>` — a field from an **earlier** step's result (give
  that step an `id` to reference it). **Forward references are rejected** —
  a step can only see steps before it, never after.

### Worked example

A `plan` → `workout` chain (`plan` has a `name`; `workout` references a
`plan` and has a `name`), with a tool that creates both in one call:

```json
{
  "app": { "id": "hyrox", "name": "Hyrox Training", "version": 1 },
  "entities": [
    {
      "id": "ent_plan", "name": "plan",
      "fields": [ { "id": "fld_plan_name", "name": "name", "type": "text", "required": true } ]
    },
    {
      "id": "ent_workout", "name": "workout",
      "fields": [
        { "id": "fld_workout_plan", "name": "plan", "type": "reference", "target": "ent_plan", "required": true, "onDelete": "cascade" },
        { "id": "fld_workout_name", "name": "name", "type": "text", "required": true }
      ]
    }
  ],
  "tools": [
    {
      "id": "tool_create_plan", "name": "create_plan",
      "description": "Create a new training plan together with its first workout",
      "params": [
        { "id": "p_plan_name", "name": "plan_name", "type": "text", "required": true },
        { "id": "p_workout_name", "name": "workout_name", "type": "text", "required": true }
      ],
      "steps": [
        { "id": "plan", "op": "create", "entity": "ent_plan", "set": { "name": "$params.plan_name" } },
        { "id": "workout", "op": "create", "entity": "ent_workout", "set": { "plan": "$steps.plan.id", "name": "$params.workout_name" } }
      ]
    }
  ]
}
```

Note how `fld_workout_plan.target` (a field constraint), the tool param's
implicit link, and the step's `"$steps.plan.id"` reference all agree on
`ent_plan` — every cross-reference in a manifest has to point at a real id
declared elsewhere in the same document. This is the single biggest source
of mistakes; when in doubt, `grep` your own draft for an id before trusting
a reference to it.

### UI components (`ui/components/<Name>.tsx`)

By default a tool's result renders as raw JSON in a generic tool-call card.
For a tool whose result deserves a real look — not internal bookkeeping —
write a React component and reference it from that tool:

```json
{ "id": "tool_get_workout", "name": "get_workout", "steps": [...],
  "ui": { "component": "Workout" } }
```

This resolves to `ui/components/Workout.tsx`, built into a self-contained
MCP Apps resource and served to whatever client is chatting — Open
Workbench's own chat renders it in a sandboxed iframe, and so does any other
MCP-Apps-capable host. Several tools can share one component (e.g.
`create_workout` and `get_workout` both rendering via `Workout.tsx`) — set
the same `ui.component` on each.

Rules for the component itself:

- Import presentational primitives from `@openworkbench/app-ui-kit`: `Card`,
  `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`,
  `Badge`, `Stat`, `Heading`, `Eyebrow`, `Muted`, `Table` and friends. Use
  Tailwind utility classes for anything else — the same design language as
  the rest of Open Workbench, so a component reads as belonging to the
  product, not a random one-off page. An accent-colored `Badge` (`variant="accent"`)
  or a `Stat` block are usually enough to make a card feel like *this app's*
  own look and feel, seeded from the app's own `manifest.json` `app.color`
  automatically — you don't need to hardcode colors yourself.
- Default-export a single function component. Its props are that tool's
  result row — import the matching interface from `../generated/entities.d.ts`
  (regenerated by `validate_app` every time you call it, from your current
  manifest's entities) instead of guessing field names:

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
- Props arrive exactly as the entity's fields are named in the manifest,
  plus the platform's own `id`/`created_at`/`updated_at` — treat every prop
  as possibly absent (`Partial<...>`) since a `list` tool's rows and a
  single-row tool's result aren't guaranteed to carry identical shapes.
- Don't write the App-bridge/connection boilerplate yourself — that's fixed
  infra (`@openworkbench/app-ui-kit`'s shell) wired in automatically when
  `validate_app`/`present_app` build the component. You only ever write the
  presentational component itself.

`validate_app` type-checks every component against the real entity types and
reports the exact error if one doesn't compile — treat that the same way you
treat a manifest validation error: fix it and re-validate before presenting.

### Seed data (`data/<entity>.json`)

One JSON array of row objects per entity, shaped like a create request
body. A row may carry a `"$key"` string to label it for a later file's
reference field to point at (as `"$<entity_name>.<key>"`); entities seed in
the order they're declared in the manifest, so seed a referenced entity's
file before whatever references it.

```json
[
  { "$key": "p1", "name": "Base Plan" }
]
```

### Skills (`skills/<name>/SKILL.md`)

Same frontmatter (`name`, `description`) + markdown body shape as this
file. Write one when the app has its own tools and an agent using this app
later would benefit from guidance on *when and how* to call them — not
just as a restatement of the manifest.

## Workflow

1. Read the user's description, then call `ask_questions` **exactly once**
   with 3-6 questions — always, even if the request looks fully specified.
   Every app has open decisions (which fields matter most, what's required
   vs optional, sensible defaults, whether to seed starter data) and this
   is the user's one easy chance to steer before you commit to a design,
   so front-load every open decision here rather than trickling questions
   in plain text later or guessing silently. Pick each question's `type`
   deliberately: `single_choice` when exactly one option applies (e.g.
   "which view should open first?"), `multiple_choice` when several can
   apply at once (e.g. "which fields should be required?"), and
   `free_text` when the answer is open-ended and can't be reduced to a
   short list of options (e.g. "any starter data to seed?").
2. Call `update_plan` with the concrete steps you're about to take (e.g.
   "Draft manifest.json", "Add `<entity>` entity", "Write UI components",
   "Validate", "Present for review"), each starting `pending`. Call it
   again — resending the full
   list — whenever a step's status changes, so the user watches real
   progress rather than a plan stated once and forgotten.
3. Draft `<id>/manifest.json` (and, if useful, `skills/`/`data/`) with your
   file tools.
4. For entities whose result deserves a real look (not internal
   bookkeeping), write `ui/components/<Name>.tsx` and set that tool's
   `"ui": { "component": "<Name>" }` — see "UI components" above.
5. Call `validate_app({ id })` — cheap, side-effect-free, safe to call
   often. Fix whatever it reports (including any UI component type errors)
   and re-validate.
6. Once it validates clean, call `present_app({ id })` — this hands the
   draft to the user as a review card with an install button. It does
   **not** install anything; that's the user's own action from that card.
   Your job for this app is done once you've presented a valid draft. If
   the user asks for changes afterward, edit the files, re-validate, and
   call `present_app` again to refresh the card — never install on their
   behalf.
