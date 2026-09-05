---
name: app-design
description: How to turn a user's app request into a well-shaped Open Workbench app — the translation from user goal to entities, tools, UI, and seed data, and when to prefer the smallest useful design. Read this before drafting manifest.json for any new app.
---

# App design

Open Workbench apps are declarative: a `manifest.json` (see the
`manifest` skill for its exact shape) plus optional tools, UI, seed data,
and skills. This skill is about *what* to put in that manifest, not the
JSON syntax for it.

## The translation

```
User goal
   ↓
Core workflows        what does someone actually do with this, repeatedly?
   ↓
Entities + relationships   the durable nouns that workflow touches
   ↓
Task-oriented agent tools  the verbs an agent should be able to call
   ↓
Useful rendered views      which results deserve a real look, not raw JSON
   ↓
Optional starter data      does a first run benefit from example rows?
```

Work top-down. Don't start from "what fields could this entity have" —
start from what the user is trying to accomplish, then let the data model
fall out of that.

## Prefer the smallest useful app

Open Workbench supports entities, references, enums, multi-step tools,
rendered UI, seed data, and app-owned skills. None of that is a checklist
to fill in. A todo app needs an entity, maybe two fields beyond the
platform defaults, and a couple of CRUD tools — nothing else. Speculative
complexity (a `priority` enum nobody asked for, a `tags` entity for a
single-user list, a UI component for a mutation acknowledgement) makes
the app harder to reason about without making it more useful. When in
doubt, leave it out — it's easy to add later; it's not easy for the user
to notice they don't need it.

## Durable nouns become entities

An entity should represent information the application actually stores
and later reads back: `project`, `task`, `workout`, `exercise`,
`customer`, `opportunity`. Not every noun the user says becomes one —
"track my workouts" doesn't need a `workout_type` entity if a `text` or
`enum` field on `workout` says the same thing with less machinery. Ask:
does this concept need its own rows, with its own lifecycle, referenced
from elsewhere? If not, it's a field.

## Relationships should reflect the domain

Use `reference` fields where objects genuinely belong together (a
`workout` belongs to a `plan`; an `opportunity` belongs to a `contact` and
a `company`). Keep the reference graph shallow and readable — if you find
yourself drawing a diagram to explain it, it's probably more than this
app needs. Set `onDelete` deliberately: `cascade` when the child is
meaningless without the parent, `set_null` when it should survive
orphaned, `restrict` when deleting the parent should be blocked instead.

## User/agent actions become tools

A tool is the app's agent-facing interface, not a mechanical mirror of
the database. Prefer a name that says what happened —
`create_training_plan`, `log_workout`, `complete_task`,
`move_opportunity_stage` — over generic `create_row`/`update_row` unless
plain CRUD *is* the natural domain action (a simple todo app's
`create_task`/`complete_task` is already domain-shaped; don't dress it up
further). See the `tools` skill for the step DSL and for when a single
user intent should become one atomic multi-step tool (e.g.
`create_training_plan` creating a plan and its first workout together).

## UI should be intentional

Write a `ui/components/<Name>.tsx` (see the `ui` skill) when a tool's
result is something users will repeatedly look at, is information-dense,
benefits from visual hierarchy, or is a primary object of the app — a
workout summary, a ticket card, a collection entry. Skip it for mutation
acknowledgements ("created"), raw ids, internal bookkeeping entities, or
anything a plain structured result already conveys clearly. Most tools in
a small app don't need one.

## Seed data should improve first-run experience

Write `data/<entity>.json` (see the `seed-data` skill) only when starter
rows genuinely help someone understand or immediately use the app on
first install — a couple of example tasks in a todo app, a starter
training plan in a workout app. Don't seed rows just to have something to
look at; an app with no natural example content is fine with none.

## Worked judgment calls

- **"Build me a simple todo app."** No open product decisions — infer a
  `task` entity (`title`, `done`), CRUD tools, no UI, no seed data, and
  build it.
- **"Build me a CRM for our sales team."** Real ambiguity: contacts vs.
  companies as separate entities, whether opportunities/pipeline stages
  exist, whether activities are tracked. Worth a question or two before
  designing.
- **"Build me something like Notion."** Too unscoped to design anything
  — ask what it's actually for before writing a manifest.
