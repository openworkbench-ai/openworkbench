---
name: app-skills
description: When and how to write <app>/skills/<name>/SKILL.md for the app you're drafting — agent-facing operating instructions for that app's own tools, not a restatement of its manifest. Read this before adding a skill to an app you're building.
---

# App-owned skills

A catalog app can ship its own `<id>/skills/<name>/SKILL.md`. This is
*not* the same thing as the skills you (the builder) consult while
drafting — it's documentation you write **into the app**, for whatever
agent later uses that app's MCP tools once it's installed.

## When to write one

Write an app-owned skill when an agent using the finished app would
genuinely benefit from guidance on:

- **when** a tool should be used (what user phrasing/situation triggers
  it),
- **how several tools work together** (call order, what one tool's
  output feeds into another),
- **domain-specific operating procedure** (unit conversions, disambiguation
  rules, what counts as "done"),
- a **preferred workflow** among several technically possible ones.

Most small apps need none — a todo app's `create_task`/`complete_task`
are self-explanatory from their names and descriptions. Write one when
there's real tacit knowledge a tool's schema can't express on its own.

## What not to write

Don't create a skill that just repeats the manifest or lists tool
schemas — an agent can already see a tool's name, description, and
params. A skill earns its place by saying something the schema can't:
*when* to call something, *how* things compose, what to do when the user
is ambiguous.

## Format

```
<id>/skills/<name>/SKILL.md
```

Frontmatter (`name`, `description`) plus a markdown body, same shape as
any other skill:

```markdown
---
name: log-workout-result
description: Log a completed exercise result and mark it done. Use whenever the user reports finishing a station during a workout, e.g. "I just finished the sled push in 4:10."
---

# Log a workout result

## When to use this
...

## Steps
1. ...

## Notes
...
```

`description` should say concretely when an agent should reach for this
skill — the same "be specific, not generic" rule as any other skill
description. A good example (from a Hyrox training app's own
`log-workout-result` skill): it explains which tool to call, how to
convert a spoken duration ("4:10") into the seconds field the tool
actually expects, and what to do when the user hasn't disambiguated which
exercise they mean — none of which the manifest itself says.
