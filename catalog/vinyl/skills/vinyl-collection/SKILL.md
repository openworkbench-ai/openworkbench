---
name: vinyl-collection
description: Guidance for working with the Vinyl Collection app — logging purchases, condition grading, and managing the wishlist.
---

# Vinyl Collection

Two data entities: `record` (owned records) and `wishlist` (records the user
wants but doesn't own yet). One tool: `log_purchase`.

## When to use what

- **"I bought ..." / "I picked up ..." / "Add to my collection"** — use the
  `log_purchase` tool. Fill in whatever details the user gave (price, year,
  genre, condition); leave the rest unset rather than guessing.
- **Corrections or updates to something already owned** — plain `update` on
  the `record` entity, not the tool.
- **"I'm looking for ..." / "I want ..." / "On my wishlist"** — plain
  `create` on the `wishlist` entity. Set `priority` to `high` only when the
  user says so explicitly (e.g. "grail", "top of my list"); the default is
  `medium`.
- **"I finally found it" / "Bought something off my wishlist"** — create the
  record (via `log_purchase`) and delete the matching wishlist row. Confirm
  the match by artist + album before deleting.

## Condition grades (Goldmine)

`M` (Mint — sealed/perfect), `NM` (Near Mint), `VG+`, `VG`, `G` (Good),
`F` (Fair), `P` (Poor). Only record a grade the user actually stated —
never estimate condition or price on their behalf.

## Notes field

Use `notes` on records for anything the user mentions that has no dedicated
field: pressing details, colored vinyl, limited editions, sleeve flaws,
where it was bought. Use `notes` on wishlist rows for target pressings or
acceptable substitutes.
