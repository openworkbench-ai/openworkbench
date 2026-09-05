---
name: run-tournament
description: How to set up and run the padel tournament end to end — randomly pairing players into teams, generating the round-robin schedule, computing standings, and seeding semifinals/final. Use this whenever the user asks to start the tournament, generate the schedule, see the standings, or set up the semis/final.
---

# Running the padel tournament

This app has no single "run tournament" tool — you compose the CRUD/list
tools below yourself, in this order.

## 1. Assign teams randomly

Players are seeded as `player` rows on install. To form teams:

1. Call `list_teams` — if teams already exist, don't recreate them; the
   draw already happened.
2. Otherwise, read the full player list (via the entity's list
   operation), shuffle it randomly, and pair them up 2-by-2 into 5 teams.
3. Call `create_team` once per pair. Name each team something simple like
   "Ferdi & Nick" (the two players' names joined).

Do this once. Re-running the draw after matches exist would orphan
results, so don't reshuffle if teams already exist — ask the user first
if they explicitly want a re-draw.

## 2. Generate the round-robin schedule

Every team must play every other team exactly once — with 5 teams that's
10 matches. Call `schedule_match` with `stage: "round_robin"` for every
unique pair of teams (combinations, not permutations — don't create both
A-vs-B and B-vs-A).

## 3. Record results

As each match is played, call `record_match_result` with the match id,
each team's sets won, and the winning team's id. Ask the user how many
sets they're playing via `get_settings`/`set_sets_per_match` before the
tournament starts if they haven't said.

## 4. Compute standings

There's no standings tool — compute it yourself from `list_matches`
(filtered to `stage: "round_robin"` and `played: true`) and `list_teams`:

- Rank teams by **match wins** (count of round_robin matches where
  `winner` is that team).
- Break ties by **head-to-head result only** — if two teams are tied on
  wins, whichever beat the other in their round-robin match ranks higher.
  If a tie can't be resolved by head-to-head (e.g. a 3-way tie), tell the
  user the standings are ambiguous instead of guessing.

## 5. Seed and schedule semifinals, then the final

Once all round-robin matches are `played`:

1. Take the top 4 teams from standings: 1st, 2nd, 3rd, 4th.
2. Call `schedule_match` twice with `stage: "semifinal"`:
   - 1st vs 4th
   - 2nd vs 3rd
3. After both semifinals are recorded via `record_match_result`, call
   `schedule_match` once with `stage: "final"` between the two semifinal
   winners.
4. Record the final's result the same way. That team is the champion.
