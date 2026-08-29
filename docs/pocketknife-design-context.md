# Pocketknife — Design & Context

> A single document capturing what Pocketknife is, the architecture we've converged on, the decisions and their rationale, the risks, the competitive context, the build plan, and what we're building first. Written as context for anyone joining the project.
>
> **Name note:** the project was originally "Pocket," renamed to **Pocketknife** to escape a crowded namespace (PocketBase, the defunct Mozilla Pocket, Pocket ID all sit in the same self-hosting search results). The new name also fits the pitch — a pocketknife is a small collection of useful tools you carry with you.
>
> **Companion documents** (the detailed dossier this summarizes): the implementation plan, the competitive landscape, the PocketBase build-vs-buy evaluation, the Claude Code build prompt for v1, and the architecture diagram.

---

## 1. What Pocketknife is

Pocketknife is an **open-source, self-hostable personal app platform** — a home screen for the small apps you build yourself. Each app is a colored squircle tile with an emoji, arranged iPhone-style on a home screen. Unlike a throwaway chat artifact, every app is backed by a real API and its own database, so it persists and runs on its own.

You add an app by tapping **+ New App** and either pasting a frontend (e.g. something vibe-coded with Claude) or describing what you want. The model drafts a plan — features, screens, data model, API — and shows it to you. You refine it by chat until it's right, approve, and the app builds in the background (the tile shows an installing progress ring) until it's ready to open full-screen.

**One line:** turn your vibe-coded frontends into real, owned apps — and collect them all in one place.

We deliberately dropped the "super app" framing — it drags in WeChat walled-garden connotations that cut against the open, you-own-it angle.

## 2. The core thesis

Everything hangs off one idea:

> **Don't generate a program — generate a declarative *spec* of the data (the Manifest). Derive the running app from it deterministically. And because the spec carries stable identity, diff two versions and migrate without losing data.**

Generating free-form application code against a database is the failure mode the entire design exists to avoid: it's unreliable to deploy, impossible to migrate safely, and turns "make a change" into a rewrite that destroys data. A declarative, diffable spec fixes all three.

## 3. Architecture

**The Manifest is the IR.** An app is described by a `manifest.json`: app metadata, entities, typed fields, relationships, functions, and a frontend entry. Almost everything else — the CRUD API, the query interface, the typed client — is *derived* from it, not declared, which keeps the manifest small and the derivation deterministic. JSON, not YAML: the manifest is authored by the LLM and diffed by the machine, so we want the smallest ambiguity surface, reliable model emission, and native JSON Schema validation.

**Stable IDs are the spine.** Every entity and field carries an immutable `id` separate from its human `name`. Names are display/machine sugar and can change; the `id` is what migrations diff against. Rename `deadline` → `dueDate` and an id-based diff sees the *same column* and preserves the data, where a name-based diff would see drop-plus-add and destroy it. This single decision is most of why declarative beats a code blob.

**One generic backend, no per-app server.** A manifest does not compile to server code. It registers a schema with one generic, schema-driven server that already knows how to serve any schema. "Build a backend from a manifest" means: validate it, create the app's tables, and add its schema to an in-memory registry. CRUD, queries, and aggregations fall out of the schema. There is no codegen, no per-app process, no flaky deploy step.

**One SQLite file per app.** Each app's data lives in its own `data.db`. This gives physical isolation between apps, cheap snapshots (copy the file before a risky migration → one-click undo), blast-radius containment, and a clean self-host story (an app is just a folder: manifest + db + assets).

**The trust boundary — the LLM lives *outside* the trusted core.** The model is an untrusted synthesis oracle. It only *proposes*; a validator/verifier checks every output before it touches the pipeline. Reliability is therefore a property of the verifier's soundness, not the model's accuracy. The operational rule is "verify, don't trust": nothing the model emits reaches the system unchecked.

**The sandbox is the real security boundary — not the manifest.** The manifest only *declares* what a function may touch. Something must *enforce* that at runtime, and that enforcement is the load-bearing security work. All LLM-authored function code is treated as hostile by default.

**All outside contact goes through capability-gated functions.** Network calls and model calls happen only inside sandboxed functions with declared capabilities (data scopes, allow-listed domains, model access). The model/API token is brokered server-side and never reaches the browser; there is deliberately no "frontend network" capability, because a raw browser fetch is ungateable. The install consent screen is *derived* as the union of every function's declared capabilities, not authored.

**The migration engine is the actual product.** Creating an app is the demo; evolving one without losing data is the product, and it's the hardest engineering. The engine computes a structural diff between two manifest versions by stable id. Additive and widening changes are information-preserving and auto-apply. Narrowing, dropping, and type-changes are information-losing and require a *witness* (a coercion/backfill rule), an explicit confirm, and a snapshot first. The model may propose a changeset, but the platform's computed diff is ground truth and *verifies* the model's annotations against it.

**A small, closed type set.** text, integer, real, boolean, date, datetime, enum, reference, and `json` as a discouraged escape valve. A tight type set is what makes validation, querying, and migration mechanical.

**The escape hatches are where the nice properties break — minimize time in them.** `json` is the untyped fragment (not queryable, validatable, or migratable). Functions are the Turing-complete fragment (they escape static analysis and force runtime enforcement). The discipline is keeping apps in the typed core. The single biggest lever for that is **query-API expressiveness**: if filtering and aggregation aren't rich enough, every generated app routes around the core into `json` or a function. Query expressiveness is the pressure valve.

A useful set of framings for the architecture, in increasing depth: it's a **compiler** (manifest = IR, derivation = a pure, total lowering function); it's a **schema-evolution** system (stable identity makes the structural diff well-defined, the way Git's heuristic rename-detection is not); and at root it's a **restricted, non-Turing-complete language co-designed with a model and a verifier** — restricted precisely so that derivation, diffing, and migration synthesis stay decidable and total, which is what lets the LLM be ejected from the trusted computing base entirely.

## 4. Shell vs. Factory

Pocketknife is two products that look like one.

**The shell** is the hand-built, trusted, branded surface: login, the launcher grid of tiles, the new-app sheet (Describe / Paste code), the plan-review chat, and the building state. It is the **superuser console** — the single most privileged surface — and is exempt from the sandbox, which makes it the biggest attack surface precisely *because* it's trusted. It needs real-time build progress and animation, so ironically it's the one "app" that can't go through the factory's own constraints.

**The factory** is the constrained pipeline that fills the shell with model-authored apps: validate → derive → build → activate, plus migration and the sandbox.

**The platform has its own database**, distinct from the per-app DBs: the app registry (tiles, emoji, color, order), the plan-review conversations and their evolving plan versions, and the build jobs and their status. This is a new single point of failure sitting above the isolated apps — lose a per-app DB and you lose one app; lose the platform DB and the launcher goes dark.

**Single-user by design.** There is one superuser; we skip multi-tenancy, per-app auth, and team/RBAC complexity entirely. Auth is **magic-link** (we dropped "Continue with Apple" — tying identity to an external provider contradicts an open, self-hosted product on the very first screen). Magic-link implies the box sends email, which implies a recovery path so an SMTP failure isn't permanent lockout.

The launcher is *almost* a Pocketknife app itself (the registry and conversations are CRUD-shaped), but build orchestration is Turing-complete, so the shell can't fully eat its own dogfood and stays hand-built.

## 5. The moat

The defensible core is **not** generation — anyone can generate code, and the model labs do it for free. The moat is three things together: the **verifier** (the trust boundary that makes installs safe), the **migration engine** (what lets an owned app survive change), and the **owned collection** itself (a personal home screen of apps on your own box). The structural differentiator that the cloud AI-app-builders can't easily copy is **self-hosted, owned, portable** — your data on your machine, no platform in the middle. The standing risk is timing: a major lab shipping "artifacts, but with a database" before Pocketknife is known.

## 6. Risks we're carrying (from the stakeholder review)

- **Design consistency (frontend).** A beautiful launcher full of inconsistent generated apps feels *more* broken than an ugly one. Mitigation: a component kit that generated frontends inherit, so the inside matches the outside.
- **The migration engine is the hard, valuable thing (backend).** A single mis-computed diff on someone's only copy of their data is unrecoverable trust loss. Also: the platform DB is a new single point of failure.
- **Self-host reality (devops).** Runs on a stranger's NAS. Magic-link needs SMTP and risks lockout; build progress must stream over a long connection on weak hardware; updating the platform must not dark out apps built against an older derived client; the install ring must have a real failure state, not just a happy path.
- **The sandbox is the boundary, the shell is the prize (security).** The manifest only declares; the sandbox enforces. All functions are hostile until proven otherwise. `json` is an uninspectable exfiltration surface. The trusted shell and the planning model behind the text box (prompt injection via paste-code) are the real attack surfaces.
- **The product is the second deploy (PM).** The create flow demos itself and will get all the attention; retention is decided by whether "add a field" loses data. The plan-review is a *stateful conversation that mutates a plan*, and the building state needs a sad path.
- **Timing and brand (CEO).** The moat is the verifier, the migration engine, and the owned collection — fund those over a flashier create flow. Don't fall in love with the shell and starve the factory.

## 7. Competitive context

No existing product occupies Pocketknife's exact cell — *self-hosted + schema-as-IR with verified migrations + a personal home-screen collection of the results.* The parts exist separately across adjacent clusters:

- **PocketBase** — closest to the derive pipeline (schema → generated REST API → single SQLite file → single Go binary, self-hosted). No generation, no manifest/migration-diff layer, single-tenant. Evaluated as a foundation and **rejected** (see §8).
- **Val Town / Townie** — closest to the generative loop (chat → full app with backend + DB, live in seconds). Cloud-only, generates free-form code with no formal migration story — the cautionary tale for what Pocketknife is *without* its migration engine.
- **Umbrel / CasaOS / Homarr** — the shell's visual competitive set (a home screen of installed apps on your own box), but they only launch pre-built third-party software; they generate nothing. Note: Umbrel's license has drawn "not really open source" criticism — a genuinely permissive license is a real edge with this audience.
- **AI app builders (Lovable, Bolt, Replit, v0)** — prove the demand, but cloud-only, free-form code, same unsolved migration gap.
- **Self-hosted low-code (Budibase, NocoDB, Appsmith)** — prove the schema-to-app pattern is sound, production-grade engineering, but they're team/RBAC tools built by drag-and-drop, not chat, and not a personal home screen.
- **Claude's own persistent artifact storage** — the nearest first-party overlap (key-value persistence for generated artifacts), with no schema, no migrations, no home screen. The cheapest signal to watch for platform risk.

**Steal:** PocketBase's shape for the data plane, Townie's conversational loop as UX validation, Umbrel's visual bar, the low-code track record as proof the derivation is sound. **Avoid:** free-form code against a DB with no migration story, cloud-only defaults, team/RBAC complexity.

## 8. Why we're building it ourselves (not on PocketBase)

PocketBase is excellent for the *commodity* half (it's close to a finished derive pipeline, MIT-licensed, single binary) and a poor fit for the *differentiating* half. The decisive collisions:

- **Isolation.** PocketBase is single-tenant by design — one instance, one database file. Our per-app-SQLite model has no clean mapping: shared-instance loses physical isolation and cheap file-copy snapshots; instance-per-app means dozens of processes on a NAS, which is exactly the heavy model we designed against.
- **The sandbox.** PocketBase's JS layer (goja) is built to run *trusted* code with broad OS/filesystem/network access — the opposite of what our untrusted, LLM-authored functions need. It offers zero help on our hardest, most differentiating security work, and is a hazard if used there.
- It helps only with Phase 1, couples us to a pre-1.0 dependency, and we'd build the sandbox, migration safety engine, generation, and shell ourselves regardless.

The decision reduced to one conscious fork — *is per-app physical isolation a requirement or a nice-to-have?* — and we chose: **it's a requirement, so we build our own data plane.** PocketBase was judged overkill for what it would actually buy us.

## 9. Implementation plan (nine iterations)

The ordering *is* the argument: prove the trust-critical, hard-to-change machinery end-to-end **with the LLM entirely absent**, then admit generation, then dress the shell, then harden. Build the factory before the shell, so we never ship a beautiful empty home screen.

| Phase | Iteration | LLM present? |
|---|---|---|
| 0 | The contract + skeleton (Manifest & Changeset formats, validator, runtime skeleton, platform store) | No |
| 1 | The derive pipeline (manifest → per-app SQLite + generic CRUD/query API + typed client) | No |
| 2 | Build & activation (frontend bundle, the install state machine with a real failure path) | No |
| 3 | **The migration engine** (stable-ID diff, witness-gated destructive ops, file-copy snapshot/undo) | No |
| 4 | Sandbox & capability enforcement (functions, the real security boundary, brokered token) | No |
| — | *Milestone: the entire factory works end-to-end without any LLM.* | — |
| 5 | Generation (the LLM enters, outside the boundary; plan-review loop; auto-repair against the verifier) | Yes |
| 6 | The shell (the mockup-grade launcher + the component kit generated apps inherit) | Yes |
| 7 | Self-host hardening (packaging, magic-link/SMTP recovery, broker hardening, update-without-breakage) | Yes |
| 8 | Open-source release & safe sharing (verified install of shared manifests, scope boundary made explicit) | Yes |

**Scope for v1.** In: CRUD-shaped single-user personal apps; describe + paste-code creation; safe evolution; sandboxed functions for outside contact; full self-hosting; sharing via verified manifests. Out (function hatch or later): real-time/collaboration/multi-user, heavy compute, arbitrary runtimes, app-to-app data sharing, multi-tenant hosting, a marketplace.

## 10. What we're building first

The first concrete build is **"our version of PocketBase"** — the Phase 1 derive pipeline, in Go, driven by a hand-authored manifest with no LLM, shell, or migrations yet. The guiding discipline: **nail the contract, keep coverage small.**

- **Nail (correct + stable, because everything builds on it):** the manifest shape, stable IDs as the spine, the type→SQLite mapping, the per-app-file boundary, and the API's URL/JSON shapes.
- **Keep small (grow on demand):** the number of types and query features. Start with what the first apps need, not the full set.

The five pieces of the v1 component: a **schema model**, a **validator** (with a written `manifest.schema.json`), a **materializer** (schema → SQLite DDL, one file per app), one **generic CRUD + list/filter/sort/paginate handler**, and a **boot loader + registry** that re-derives from disk on startup.

v1 closed type set: text, integer, real, boolean, datetime, enum, reference. v1 query: single-field filters with seven operators (`eq, ne, gt, gte, lt, lte, like`), AND-combined, plus sort and limit/offset — deliberately no OR, nesting, or joins yet. Explicitly deferred: migrations, the typed client, functions/sandbox, the LLM, auth, and the shell (leave clean seams, don't implement).

**The honest test that it's "nailed enough" to move on:** stand up three genuinely different hand-authored apps — a tracker, an append-only log, and a two-entity app with a reference — and confirm the layer holds without wanting to change any of its shapes. If inventing a *fourth* app makes you want to change a manifest or API shape, it isn't stable yet. If the only thing missing is more types or query power, that's deferred scope, and the next component (the migration engine) is what will confirm the schema model was designed well — because a model that's awkward to *diff* was missing structure.

## 11. Tech stack and how Go + TypeScript fit together

Pocketknife is polyglot, split along the trust boundary rather than across it.

- **Go = the trusted core.** The manifest runtime, per-app SQLite, the generic CRUD/query API, and later the migration engine and the function sandbox. A single static headless binary serving HTTP+JSON. Chosen for the single-binary, low-memory, first-class-SQLite profile that suits self-hosting on a NAS.
- **TypeScript = everything above the wire.** The shell, the generated per-app frontends, and the LLM orchestration (planning conversation, calling the model, validating its manifest output — I/O-bound glue, not hot-path or security-critical).

They never share a process, a build, or a type system — they share a **wire protocol (HTTP + JSON)**. The integration surface is exactly the API contract already specified (URL scheme, JSON shapes, query syntax, error envelope, status codes).

The piece that makes the split feel like one typed system: **the typed client is generated from the manifest**, so the Go backend and the TS frontend agree by construction — neither hand-maintains the other's types. The manifest is the single shared artifact; optionally a generated OpenAPI document can restate the generic routes for TS client generation, but the manifest is the deeper source. We explicitly do **not** share Go structs and TS interfaces directly — that would recreate the coupling the wire boundary exists to prevent.

Deployment: in dev, the Go API and the TS shell run on separate ports with CORS enabled. In production, the Go binary serves the built TS static assets *and* the API from one origin — no CORS, one self-hostable process, which is the whole point. (A small addition to the v1 Go build keeps it headless, CORS-configurable in dev, and able to serve a static directory in prod.)

## 12. Glossary

- **Manifest** — the declarative JSON spec of an app (entities, typed fields, relations, functions, frontend). The IR; the single source of truth.
- **Changeset** — the ordered deltas between two manifest versions, accompanying a new version on an edit.
- **Stable ID** — the immutable `id` on every entity and field, separate from its mutable `name`; the spine that makes diffs and migrations safe.
- **Derive / materialize** — turn a validated manifest into a live schema: create the per-app SQLite tables and register the schema. Deterministic, repeatable.
- **Registry** — the in-memory, derived index of registered app schemas; the request hot-path. Rebuilt from disk manifests on boot.
- **Factory** — the constrained pipeline that turns manifests into running apps (validate → derive → build → activate, plus migrate and sandbox).
- **Shell** — the hand-built, trusted launcher UI (login, grid, new-app sheet, plan-review, building state). The superuser console.
- **Witness** — the extra input (a coercion/backfill rule) a destructive migration requires before it can run.
- **Broker** — the server-side holder of the model/API token; functions reach the model only through it, so the token never hits the browser.
- **Verifier / validator** — the gate that checks every model output (manifest, changeset) before it touches the pipeline; reliability rests on its soundness.

## 13. Current status & next steps

- Architecture is converged and reference-ready (this document plus the companion dossier).
- Decided to **build the data plane ourselves** rather than on PocketBase.
- Renamed **Pocket → Pocketknife** to clear the namespace.
- **Next concrete step:** build the v1 manifest backend in Go using the Claude Code build prompt, proving it against the three acceptance apps.
- **After that:** the migration engine (Phase 3) — which will also stress-test whether the schema model was designed well.

The thing to protect through all of it: the LLM stays outside the trusted core, the sandbox stays the real security boundary, and data safety (snapshot before every destructive change) stays non-negotiable. Those three, plus the owned-collection experience, are what Pocketknife actually is.
