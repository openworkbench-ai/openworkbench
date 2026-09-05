---
name: seed-data
description: How to write data/<entity>.json starter rows — shape, $key cross-references, seed order, and first-install-only semantics. Read this before adding seed data to an app.
---

# Seed data

`<id>/data/<entity>.json` is one JSON array of row objects, one file per
entity, shaped exactly like that entity's create request body:

```json
[
  { "$key": "p1", "name": "Base Plan" }
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
// data/plan.json
[ { "$key": "p1", "name": "Base Plan" } ]
```

```json
// data/workout.json
[ { "plan": "$plan.p1", "name": "Week 1" } ]
```

Entities seed in the order they're declared in the manifest's `entities`
array — so seed a referenced entity's file (here, `plan`) before
whatever references it (`workout`). Getting the order backwards means the
reference can't resolve yet when it's applied.

## When seed data runs

Seed data is applied only the **first time** an app is installed, against
a fresh database. Editing `data/*.json` after that point has no effect on
an already-installed app's existing rows — don't rely on it for anything
beyond initial demo/starter content, and never rely on it for runtime
application logic (a tool or default that only works because a specific
seeded row exists is a bug waiting for a second install with different
seed data, or none).

## When to use it

Only when starter rows genuinely help someone understand or immediately
use the app on first run (see the `app-design` skill) — a couple of
example tasks in a todo app, a starter training plan in a workout app.
Most apps don't need any seed data at all; don't add it as a default
gesture.
