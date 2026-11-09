---
name: tools
description: Open Workbench tools — CRUD steps, params, references, and Python functions executed as Wasm. Read this before writing an app's tools array or Python function source.
---

# Tools

A manifest's `tools` array is the app's **agent-facing interface** — what
an MCP client can actually call. The engine executes CRUD underneath, but
the tool surface should read as meaningful operations, not a mechanical
mirror of the database. See the `app-design` skill for when to prefer a
domain-shaped tool (`complete_task`, `log_workout`,
`move_opportunity_stage`) over generic `create_row`/`update_row` — plain
CRUD tools are still the right call when CRUD *is* the natural domain
action (a todo app's `create_task` needs nothing fancier).

## Shape

```json
{
  "id": "tool_id", "name": "tool_name", "description": "...",
  "params": [ { "id": "p_x", "name": "x", "type": "text", "required": true } ],
  "steps": [ ... ],
  "ui": { "component": "SomeComponent" }
}
```

- `id`/`name` follow the same `^[a-z][a-z0-9_]*$` rule as everything
  else; `ui` is optional (see the `ui` skill).
- `params`: fields (same shape as entity fields — see the `manifest`
  skill) the caller supplies when invoking the tool.
- `steps`: an ordered, **non-branching** sequence of CRUD operations
  against this app's own entities.

## Python function tools

For calculations or transformations requiring arbitrary logic, use a Python
function instead of `steps`. Declare it in the manifest's top-level `functions`
array, then reference its stable ID from a tool:

```json
{
  "functions": [{
    "id": "fn_calculate", "name": "calculate", "runtime": "python",
    "entry": "functions/calculate.py", "handler": "calculate",
    "capabilities": {}
  }],
  "tools": [{
    "id": "tool_calculate", "name": "calculate", "description": "Calculate a total",
    "function": "fn_calculate",
    "params": [
      { "id": "p_price", "name": "price", "type": "real", "required": true },
      { "id": "p_quantity", "name": "quantity", "type": "integer", "required": true }
    ]
  }]
}
```

Write `<app-id>/functions/calculate.py`:

```python
def calculate(price, quantity):
    return {"total": round(price * quantity, 2)}
```

- A tool must have exactly one implementation: `function` or `steps`.
- `handler` defaults to `main`; parameters are passed as keyword arguments.
  Omitted optional parameters without manifest defaults use Python defaults.
- The return value must be JSON serializable. Objects are returned directly;
  lists, scalars and `None` are wrapped as `{"result": value}` by MCP.
- This runs as WASI CPython inside the Go engine, with a fresh instance for
  every call: no state persists between calls. Prints do not enter the result.
- Declare dependencies in top-level `"python": {"packages": ["package==version"]}`.
  The builder resolves normal indexed package requirements and transitive
  dependencies, bundles portable wheels, and the engine imports them inside
  Wasm. There is no per-package whitelist. Native extensions require a
  compatible Wasm build; this distribution supports portable pure-Python wheels.
- Grant HTTPS access with function `"capabilities": {"network": ["example.com"]}`.
  Existing `urllib.request.urlopen` calls are adapted to the engine's fetch;
  exact hostnames are checked on every redirect. Raw sockets stay unavailable.
  `pocketknife.urlopen` exposes the same bridge. Other HTTP libraries that use
  raw sockets need their own adapter.
- No host environment, subprocesses, writable filesystem or Python bridges to
  app data/model capabilities. Use separate CRUD tools to read/persist data.
- Limits: 128 MiB memory, a default 5 seconds per invocation (including
  interpreter startup), 1 MiB combined source/arguments and 1 MiB output.
  Set function `timeoutSeconds` (1–120) for longer network workflows.
  Network responses are capped at 4 MiB. Exceptions,
  syntax errors and timeouts are tool errors visible to the calling agent.
- The build tools include declared Python source files when saving/installing
  the app; `validate_app` checks their presence/references and resolves packages.
- Catalog apps still need at least one entity. Use CRUD tools for persistence.

## Steps

Each step is `{ id?, op, entity, rowId?, set?, filter? }`.

- `op` is one of `create`, `read`, `update`, `delete`, `list`.
- `create`/`list` **must not** declare `rowId`. `read`/`update`/`delete`
  **require** it.
- `set` (field → value map) is only valid on `create`/`update` — `read`,
  `delete`, and `list` steps must not declare it.
- `filter` (field → value map, AND-combined across entries) is only
  valid on `list` steps.
- A step can only call an operation the target entity's own `operations`
  allow (see the `manifest` skill) — a tool can't grant an entity more
  than it already permits.
- Give a step an `id` (unique within the tool) only when a *later* step
  needs to reference its result — a step with nothing after it that needs
  its output doesn't need one.

### Value references

Any `rowId`, or any value inside `set`/`filter`, is either a literal
(string/number/boolean) or a reference string:

- `$params.<name>` — a value the caller passed in for that param.
- `$steps.<id>.<field>` — a field from an **earlier** step's result
  (that step must have been given that `id`).

**Forward references are rejected.** A step can only see steps strictly
before it in the same tool's `steps` array — never itself, never one
after it. This is what makes an atomic multi-step tool possible: the
engine runs all of a tool's steps in one transaction, rolling back
everything if a later step fails.

## Examples

**Basic CRUD tool** — the natural action already is CRUD:

```json
{
  "id": "tool_complete_task", "name": "complete_task",
  "params": [ { "id": "p_id", "name": "task_id", "type": "text", "required": true } ],
  "steps": [
    { "op": "update", "entity": "ent_task", "rowId": "$params.task_id", "set": { "done": true } }
  ]
}
```

**Task-oriented tool over a list**:

```json
{
  "id": "tool_list_open_tasks", "name": "list_open_tasks",
  "steps": [
    { "op": "list", "entity": "ent_task", "filter": { "done": false } }
  ]
}
```

**Multi-step atomic workflow** — one user intent, several rows, must
succeed or fail together:

```json
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
```

Here `workout`'s `set.plan` references `$steps.plan.id` — the row id the
`plan` step just created — which only works because `plan` runs first and
carries the `id` the reference needs.

## Design guidance recap

Ask "what is the agent actually trying to accomplish?" before writing
steps. If the answer is "create a plan and its first workout as one
thing," write one multi-step tool, not two independent CRUD tools the
agent has to remember to call together. If the answer is "just create a
task," a single `create` step named for the domain action is enough —
don't add params, steps, or complexity beyond what that action needs.

## You don't need to cover every entity yourself

The engine automatically registers generic fallback tools for every entity
and operation it allows — `list_<entity>`, `get_<entity>`, `create_<entity>`,
`update_<entity>`, `delete_<entity>` — skipping only the exact names your
own declared tools already claim. So don't feel obligated to hand-author a
plain `list`/`get` tool just to make an entity's rows reachable; it's
already reachable. Spend your authored tools on the real task-oriented
workflows (the ones worth a dedicated name and description), and trust the
fallback to cover the rest — e.g. if your app has a `player` entity that
tools only ever *reference* (never list on its own), you don't need to add
a `list_players` tool: the generic `list_player` tool is always there.
