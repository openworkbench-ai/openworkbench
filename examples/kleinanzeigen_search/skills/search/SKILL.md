---
name: kleinanzeigen-search
description: Find listings on Kleinanzeigen by query, category and page.
---

Call `search` on the `kleinanzeigen_search` MCP server with `query`, optionally
`category`, `page`, and `pages` (at most three). It returns listing titles,
prices, dates, places, URLs and promoted-listing flags. Start with one page.
Use `create_listing` only if the user asks to save a listing.
