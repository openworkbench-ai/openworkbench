---
name: tracking-calories
description: How to log meals and manage the daily calorie goal in the Calorie Log app — using the log_meal, get_day_log, and set_daily_goal tools, and the settings singleton convention.
---

# Tracking calories in this app

The app has two entities: `meal` (what was eaten, keyed to a calendar date)
and `settings` (the daily calorie goal). There is no food library — the
meal's `name` is free text, so write what the user actually ate (e.g.
"Chicken Caesar salad").

## Logging a meal

Prefer the **`log_meal`** tool — it creates the row in one call, with
macros defaulting to 0 when not provided. Create one `meal` row per meal
or snack, never per ingredient (plain create on `meal` works too when a
tool call doesn't fit):

- `name` (required): free-text description of the meal.
- `log_date` (required): the calendar date the meal belongs to, exactly
  `YYYY-MM-DD` (the field is fixed at 10 characters). Use the date in the
  user's local timezone — "today" means their today, not UTC's.
- `meal_type` (required): `breakfast`, `lunch`, `dinner`, or `snack`.
  Late-night eating is still whatever meal it was, or `snack` if unclear.
- `calories` (required): total calories for the whole meal as an integer.
- `protein_g`, `carbs_g`, `fat_g`: totals in grams; default 0. Include them
  when known or when the user provides a recipe breakdown; don't invent
  precise-looking macros — if the user only knows calories, leave macros at
  their defaults rather than guessing.
- `notes`: optional context (restaurant, portion size, who cooked it, etc.).

If the user corrects a logged meal (wrong calories, ate something else),
`update` the existing row instead of creating a duplicate. To move a meal
to a different day, update its `log_date`.

## Reviewing a day

Use the **`get_day_log`** tool with `date` = `YYYY-MM-DD` to fetch that
day's meals in one filtered call. Sum `calories` across the rows (and
macros if useful), then compare the total against the current
`daily_calorie_goal` from settings and report the remaining surplus or
deficit. Group per `meal_type` if the user wants a breakdown.

## The settings row

`settings` holds exactly one row containing `daily_calorie_goal`. Treat it
as a singleton:

1. `list` the settings entity first.
2. If a row exists, change the goal with the **`set_daily_goal`** tool (it
   finds the row and updates it in one call) — never create a second row.
3. Only if no row exists at all, `create` one directly, asking the user
   for their goal if they haven't stated one. Never guess a calorie goal
   on their behalf. The `set_daily_goal` tool can only update an existing
   row, so it cannot be used for this first creation.
