---
name: log-workout-result
description: Log a completed Hyrox exercise result (duration, reps, notes) and mark the exercise completed. Use whenever the user reports finishing a station during a workout, e.g. "I just finished the sled push in 4:10."
---

# Log a Hyrox workout result

This skill records one exercise result against the `hyrox` app via its MCP
tool `log_exercise_result`, connecting to `/mcp/hyrox` on the running
pocketknife server.

## When to use this

The user mentions they just completed (or re-did) a station in a workout —
a duration, optionally a rep count, optionally a note ("felt strong", "form
broke down at the end").

## Steps

1. If you don't already have the exercise's id, find it:
   - Call the `list_exercise` tool (or `read_workout` with a known
     `workout_id`) to locate the exercise by its `station` value (one of:
     `run`, `ski_erg`, `sled_push`, `sled_pull`, `burpee_broad_jump`,
     `rowing`, `farmers_carry`, `sandbag_lunges`, `wall_balls`,
     `full_simulation`) and `order` within the workout.
2. Convert whatever duration the user gave you (e.g. "4:10", "4 minutes 10
   seconds") to whole seconds.
3. Call `log_exercise_result` with:
   - `exercise_id`: the exercise's id from step 1
   - `duration_seconds`: the converted duration
   - `reps` (optional): only for rep-based stations (e.g. `wall_balls`,
     `burpee_broad_jump`)
   - `notes` (optional): whatever qualitative detail the user gave
4. This one call both creates the `result` row and flips the exercise's
   `status` to `completed` — there is no separate "mark done" step.

## Notes

- `log_exercise_result` is defined in `catalog/hyrox/manifest.json` under
  `tools`; it runs as one atomic step sequence (create the result row, then
  update the exercise), so it can never leave a result logged against an
  exercise still marked `planned`.
- If the user hasn't told you which workout/exercise they mean and there's
  more than one plausible match, ask rather than guessing — logging against
  the wrong exercise silently corrupts their training history.
