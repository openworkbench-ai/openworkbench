---
name: manifest
description: The Open Workbench manifest.json specification — app metadata, entities, field types, references, and common validation mistakes. Read this before writing or editing any app's manifest.json.
---

# The manifest

`<id>/manifest.json` is the whole declarative contract for a catalog app:

```json
{
  "app": { "id": "todo", "name": "Todo", "description": "...", "emoji": "✅", "color": "#d0ab25", "version": 1 },
  "entities": [ ... ],
  "tools": [ ... ]
}
```

- `app`: `id`, `name`, `version` required; `description`, `emoji`,
  `color` optional. `version` is an integer starting at `1`.
- `entities`: **required, at least one entry.** There is no such thing as
  a catalog app with zero entities. (A pure skill/instructions bundle
  with no data model is a different, simpler kind of thing outside this
  scope — say so rather than forcing an empty entity into existence.)
- `tools`: optional array — see the `tools` skill for the step DSL.

## Ids and names

Every id (`app.id`, an entity's `id`, a field's `id`, a tool's `id`) and
every entity/field/tool `name` must match `^[a-z][a-z0-9_]*$` —
lowercase, starts with a letter, digits/underscores after. Convention:
`ent_<name>` for entity ids, `fld_<entity>_<name>` for field ids,
`tool_<name>` for tool ids — pick ids that read as what they are, since
you cross-reference them by id throughout the manifest.

Never declare a field named `id`, `created_at`, or `updated_at` — the
platform adds these automatically to every entity and every row.

## Entities

```json
{
  "id": "ent_task", "name": "task",
  "operations": ["create", "read", "update", "delete"],
  "fields": [ ... ]
}
```

- `fields`: required, at least one.
- `operations`: optional array restricting which CRUD operations the
  entity's API/tools expose (default is effectively all of
  `create`/`read`/`update`/`delete`). Only set this when an entity should
  genuinely be immutable or append-only (e.g. an audit-log-style entity
  with no `update`/`delete`) — most entities should just omit it.

## Fields

Every field needs `id`, `name`, `type`. `required` is optional on all
types; `default` is optional on all types except `boolean`; `unique` is
optional on `text`/`integer`/`real` (enforces no two rows share that
value — use sparingly, e.g. a slug or external id, not on every field).

| type | extra properties |
|---|---|
| `text` | `min`/`max` (string length) |
| `integer` | `min`/`max` (value bounds) |
| `real` | `min`/`max` (value bounds) |
| `boolean` | none |
| `datetime` | none — string default, ISO-ish |
| `enum` | **requires** `values` (non-empty string array); `default` must be one of them |
| `reference` | **requires** `target` (another entity's `id`, must exist in this manifest); optional `onDelete`: `set_null` \| `restrict` \| `cascade` |

## Worked example: cross-references

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

`fld_workout_plan.target` (a field constraint), the tool param's implicit
link, and the step's `"$steps.plan.id"` reference all agree on
`ent_plan` — every cross-reference in a manifest has to point at a real
id declared elsewhere in the same document.

## Common validation mistakes

- A `reference` field's `target` pointing at an id that doesn't exist (or
  a typo'd id — ids are exact strings, not names).
- A tool step's `$steps.<id>.<field>` pointing at a step that comes
  *after* it, or at a step id that doesn't exist — only earlier steps in
  the same tool are visible.
- An `enum` field's `default` not being one of its own `values`.
- Forgetting `required: true` on fields that make no sense empty (a
  `name` field with no default and not required silently allows blank
  rows).
- Declaring a field literally named `id`, `created_at`, or `updated_at`.
- Reusing the same id for two different things (two fields with id
  `fld_name` in different entities is fine — ids are unique per
  collection, not globally — but reusing one entity's id for another
  entity is not).

`validate_app` is the authoritative check for all of this — grep your own
draft for an id before trusting a reference to it, then let validation
confirm.
