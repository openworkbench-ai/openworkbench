---
name: calculate-total
description: Calculate prices, quantities and discounts with the Python Calculator app.
---

Use `calculate_total` on the `python_calculator` MCP server to compute a price
times a quantity, optionally applying `discount_percent` (0–100).
The tool runs Python in the engine and returns `total` and `quantity`.
If the user asks to save the calculation, use the app's `create_calculation`
tool with a label and the returned total; calculating alone does not save rows.
