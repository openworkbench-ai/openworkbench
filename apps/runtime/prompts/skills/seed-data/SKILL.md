---
name: seed-data
description: How to initialize an app with useful reference and setup data, never demo records — data/<entity>.json shape, $key cross-references, seed order, and first-install-only semantics. Read this before adding seed data to an app.
---

# Seed data

## Purpose and when to use it

Seed data initializes the app with real reference or setup data that its
intended workflows need and users will keep using. Include it when the
app's purpose calls for an initial catalog, configuration, or actual
user-provided content: an exercise library for a workout app, categories
used to classify expenses, or the user's supplied training plan.

Never add fictional tasks, customers, transactions, workout logs, or
other demo/sample records to illustrate features or fill an empty view.
Each seeded row must have a concrete role in ongoing use. Derive the
initial content from the requested app and known domain requirements;
ask for missing user-specific information when necessary rather than
inventing it. If there is no useful initial content, omit `data/` and
let users create their own records. Do not add entities solely to have
something to seed. See the `app-design` skill for the design process.

## File format

`<id>/data/<entity>.json` is one JSON array of row objects, one file per
entity, shaped exactly like that entity's create request body:

```json
[
  { "$key": "push_up", "name": "Push-up" }
]
```

- The filename's `<entity>` is that entity's **name** (not its id).
- Each element is a plain object of `field name → value`, same fields a
  `create` call would accept — don't include `id`, `created_at`, or
  `updated_at`; the platform assigns those.
- `"$key"` is an optional string label on a row, not a real field. It
  lets a *later* file's `reference` field point at this row without
  knowing the real id in advance.

## Cross-file references

A row in one entity's seed file can reference a row seeded in another
entity's file by writing `"$<entity_name>.<key>"` as the reference
field's value, where `<key>` is the `$key` string that other row was
given:

```json
// data/exercise.json
[ { "$key": "push_up", "name": "Push-up" } ]
```

```json
// data/exercise_variant.json
[ { "exercise": "$exercise.push_up", "name": "Knee push-up" } ]
```

Entities seed in the order they're declared in the manifest's `entities`
array — so seed a referenced entity's file (here, `exercise`) before
whatever references it (`exercise_variant`). Getting the order backwards means the
reference can't resolve yet when it's applied.

## When seed data runs

Seed data is applied only the **first time** an app is installed, against
a fresh database. Editing `data/*.json` after that point has no effect on
an already-installed app's existing rows. The inserted rows are normal
app data that tools and users can read, reference, and maintain during
ongoing use. Seed files initialize that data; they are not migrations,
backfills, or a mechanism for keeping installed data in sync.

Use `$key` for seed-time references and resolve runtime references from
stored data; never hard-code generated row IDs. Handle missing or
user-edited reference data deliberately rather than assuming the original
seed rows always exist unchanged. If an installed app needs new reference
data, explain that editing seed files alone will not populate it.
