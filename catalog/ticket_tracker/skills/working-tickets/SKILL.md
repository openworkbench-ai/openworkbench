---
name: working-tickets
description: How to create and manage tickets in the Ticket Tracker app — using the project description for context, sizing tickets, and writing Codex implementation prompts.
---

# Working with tickets

This app tracks tickets for a project. Two entities:

- **project** — one entry per project. Its `description` is the overall
  project description: goals, constraints, stack, conventions. It is the
  context every ticket is interpreted against. Keep it rich and current —
  when the project's scope shifts, update the description *before* writing
  new tickets.
- **ticket** — a unit of work. Fields: `title`, `description` (what and
  why), `size` (xs/s/m/l/xl), `status` (backlog/todo/in_progress/done),
  `priority` (low/medium/high), `codex_prompt` (implementation prompt for
  an AI coding agent), `project` (reference).

## Creating projects and tickets

- For a brand-new project, use the `create_project` tool — it creates the
  project together with its overall `description`. That description is the
  context every later ticket is interpreted against, so write it properly:
  goals, constraints, stack, conventions.
- Create each ticket with the `create_ticket` tool: it takes the project,
  `title`, `description`, `size` (defaults m), `priority` (defaults
  medium), and an optional `codex_prompt`; new tickets start in `backlog`.
- Write a real `description` on every ticket: the problem, the expected
  outcome, and anything a future implementer can't guess. The project
  description carries global context; the ticket description carries only
  what's specific to the ticket.

## Sizing

Pick the smallest honest size:

- **xs** — a one-line change, a config tweak, a typo fix.
- **s** — a small function or component with a clear boundary.
- **m** — a feature slice touching a few files; default when unsure.
- **l** — multi-file feature or refactor touching several subsystems.
- **xl** — architectural work. Prefer splitting an xl ticket into several
  m/l tickets referencing the same project; keep the xl ticket as the
  tracking umbrella if you do.

## Codex prompts

`codex_prompt` is the prompt you would hand to Codex (or another coding
agent) to implement the ticket. Not every ticket needs one — backlog ideas
don't — but any ticket that is ready for implementation should have one.

Write it for size:

- **xs/s** — one paragraph: what to change, where, and what "done" means.
- **m/l** — structured prompt: context line pointing at the project
  description, the goal, relevant files/modules, constraints, acceptance
  criteria, and what *not* to touch.
- Never rely on the prompt alone for global context — instruct the agent
  to read the project's `description` field as the source of truth, and
  keep the prompt focused on the ticket-specific work.

Keep the prompt up to date: if the ticket's scope changes, rewrite the
prompt before moving the ticket to `todo` or `in_progress`. Only mark a
ticket `done` when the implementation it describes has landed.

## Status flow

`backlog` (idea, not ready) → `todo` (ready: description +, if size ≥ m, a
codex_prompt) → `in_progress` → `done`. Promote a ticket out of backlog
only once its description is concrete enough to act on.
