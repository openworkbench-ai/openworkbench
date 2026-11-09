#!/usr/bin/env python3
"""Search Kleinanzeigen using only the Python 3.10+ standard library.

    from kleinanzeigen_search import search
    results = search("fahrrad", category="fahrraeder")
    results = search("fahrrad", category="fahrraeder", pages=3)

    python3 kleinanzeigen_search.py --list-categories
    python3 kleinanzeigen_search.py "fahrrad" --category fahrraeder
    python3 kleinanzeigen_search.py "fahrrad" --category fahrraeder --pages 3
    python3 kleinanzeigen_search.py "yamaha r6" --category motorraeder-roller --page 2

Returns search cards from one or more pages, including promoted listings.
Pages are fetched sequentially with a two-second pause between requests;
duplicate listings are removed. Prices retain
their displayed text (e.g. "170 € VB"). Dates with a time have a Europe/Berlin
UTC offset; date-only values stay YYYY-MM-DD; unknown dates are None. A card's
date is Kleinanzeigen's sorting date and may reflect a renewed listing.
No browser, API server, account, or third-party packages are required.
View counts require separate detail requests and are not included.

Astro decoding adapted from DanielWTE/ebay-kleinanzeigen-api.
Copyright (c) 2023 Daniel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta
from html.parser import HTMLParser
from typing import Any, TypedDict
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

BASE_URL = "https://www.kleinanzeigen.de"
BERLIN = ZoneInfo("Europe/Berlin")
# Names from Kleinanzeigen's category URLs. Any positive category ID also works.
CATEGORIES = {
    "auto-rad-boot": 210,
    "autos": 216,
    "fahrraeder": 217,
    "motorraeder-roller": 305,
    "dienstleistungen": 297,
    "eintrittskarten-tickets": 231,
    "familie-kind-baby": 17,
    "freizeit-nachbarschaft": 185,
    "haus-garten": 80,
    "haustiere": 130,
    "immobilien": 195,
    "jobs": 102,
    "mode-beauty": 153,
    "multimedia-elektronik": 161,
    "musik-film-buecher": 73,
    "nachbarschaftshilfe": 400,
    "unterricht-kurse": 235,
    "zu-verschenken-tauschen": 272,
}


class SearchResult(TypedDict):
    id: str
    title: str
    price: str
    date: str | None
    place: str
    url: str
    is_top_ad: bool


class SearchError(RuntimeError):
    """Request failed, was blocked, or returned an unrecognized page format."""


def _category_id(category: str | int) -> int:
    if isinstance(category, bool):
        raise ValueError("category must be a category name or positive integer ID")
    text = str(category).strip().lower().removeprefix("s-")
    value = int(text) if text.isdecimal() else CATEGORIES.get(text)
    if value is None or value < 1:
        raise ValueError(
            f"Unknown category {category!r}. Use a positive numeric ID or one of: "
            + ", ".join(sorted(CATEGORIES))
        )
    return value


def _build_url(query: str, category: str | int | None, page: int) -> str:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a nonempty string")
    if type(page) is not int or page < 1:
        raise ValueError("page must be a positive integer")
    query = query.strip()
    category_path = f"/c{_category_id(category)}" if category is not None else ""
    return f"{BASE_URL}/s-seite:{page}{category_path}?{urlencode({'keywords': query})}"


class _SearchHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.props: list[str] = []
        self.card_ids: dict[str, None] = {}
        self.summary: list[str] = []
        self._summary_depth = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attrs = dict(attrs)
        if tag == "article" and attrs.get("data-adid"):
            self.card_ids[attrs["data-adid"]] = None
        if tag == "astro-island" and "sortingDate" in attrs.get("props", ""):
            self.props.append(attrs["props"])
        if tag == "span":
            if self._summary_depth:
                self._summary_depth += 1
            elif attrs.get("id") == "srp-breadcrumb-summary":
                self._summary_depth = 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "span" and self._summary_depth:
            self._summary_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._summary_depth:
            self.summary.append(data)


def _decode_astro(value: Any) -> Any:
    if isinstance(value, list) and len(value) == 2 and type(value[0]) is int:
        kind, inner = value
        if kind == 0 and isinstance(inner, dict):
            return {key: _decode_astro(item) for key, item in inner.items()}
        if kind == 1 and isinstance(inner, list):
            return [_decode_astro(item) for item in inner]
        return inner
    return value


def _collect_previews(node: Any, previews: dict) -> None:
    if isinstance(node, dict):
        if "id" in node and "sortingDate" in node:
            previews[str(node["id"])] = node
        for value in node.values():
            _collect_previews(value, previews)
    elif isinstance(node, list):
        for value in node:
            _collect_previews(value, previews)


def _parse_date(value: str, now: datetime) -> str | None:
    try:
        match = re.fullmatch(r"(Heute|Gestern),\s*(\d{1,2}):(\d{2})", value.strip())
        if match:
            day = now.astimezone(BERLIN).date()
            if match[1] == "Gestern":
                day -= timedelta(days=1)
            return datetime(
                day.year, day.month, day.day, int(match[2]), int(match[3]),
                tzinfo=BERLIN,
            ).isoformat(timespec="seconds")
        return datetime.strptime(value.strip(), "%d.%m.%Y").date().isoformat()
    except (AttributeError, TypeError, ValueError):
        return None


def _parse_results(html: str, now: datetime) -> list[SearchResult]:
    parser = _SearchHTML()
    parser.feed(html)
    if not parser.card_ids:
        if "keine ergebnisse" in " ".join(parser.summary).lower():
            return []
        raise SearchError("No search cards recognized; page may be blocked or changed")

    previews: dict[str, dict] = {}
    for raw in parser.props:
        try:
            props = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(props, dict):
            _collect_previews({k: _decode_astro(v) for k, v in props.items()}, previews)

    results: list[SearchResult] = []
    for ad_id in parser.card_ids:
        ad = previews.get(ad_id)
        if not ad or not ad.get("title") or not ad.get("seoLink"):
            raise SearchError(f"Missing embedded data for listing {ad_id}; page format may have changed")
        url = urljoin(BASE_URL, ad["seoLink"])
        if urlsplit(url).hostname != "www.kleinanzeigen.de":
            raise SearchError(f"Unexpected listing URL for {ad_id}")
        results.append({
            "id": ad_id,
            "title": ad["title"],
            "price": ad.get("price") or "",
            "date": _parse_date(ad.get("sortingDate") or "", now),
            "place": " ".join(str(ad.get(k) or "").strip() for k in
                              ("locationName", "parentLocationName")).strip(),
            "url": url,
            "is_top_ad": ad.get("topAd") is True,
        })
    return results


def _fetch_page(url: str, timeout: float) -> list[SearchResult]:
    request = Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html",
        "Accept-Language": "de-DE,de;q=0.9",
    })
    try:
        with urlopen(request, timeout=timeout) as response:
            if response.headers.get_content_type() != "text/html":
                raise SearchError("Expected an HTML search page")
            html = response.read().decode(response.headers.get_content_charset() or "utf-8")
    except HTTPError as exc:
        status = exc.code
        exc.close()
        raise SearchError(f"Kleinanzeigen returned HTTP {status}") from exc
    except (URLError, OSError, UnicodeError) as exc:
        raise SearchError(f"Could not fetch Kleinanzeigen search: {exc}") from exc
    return _parse_results(html, datetime.now(BERLIN))


def search(
    query: str,
    category: str | int | None = None,
    *,
    page: int = 1,
    pages: int = 1,
    timeout: float = 20,
) -> list[SearchResult]:
    """Fetch up to `pages` consecutive pages, starting at `page` (default 1).

    category: numeric Kleinanzeigen category ID (e.g. 217), a name from
    CATEGORIES (e.g. "fahrraeder"), or None to search all categories.
    page: first page number; page=2, pages=3 fetches pages 2, 3, and 4.
    pages: positive number of pages; defaults to one for existing callers.
    timeout: timeout in seconds for each page request.

    Results are deduplicated by ID, keeping the first occurrence in page order.
    Stops early on an empty page or a page containing only previously seen IDs.
    Waits two seconds between pages. Raises ValueError for invalid inputs and
    SearchError for any fetch/parse failure, without returning partial results.
    """
    _build_url(query, category, page)  # Validate before making any requests.
    if type(pages) is not int or pages < 1:
        raise ValueError("pages must be a positive integer")
    if timeout <= 0:
        raise ValueError("timeout must be positive")

    results: dict[str, SearchResult] = {}
    for number in range(page, page + pages):
        if number > page:
            time.sleep(2)
        try:
            rows = _fetch_page(_build_url(query, category, number), timeout)
        except SearchError as exc:
            raise SearchError(f"Page {number}: {exc}") from exc
        new_rows = [row for row in rows if row["id"] not in results]
        if not new_rows:
            break
        for row in new_rows:
            results.setdefault(row["id"], row)
    return list(results.values())


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("query", nargs="?", help="Search text")
    parser.add_argument(
        "--category", help="Category name or numeric ID; see --list-categories; default: all"
    )
    parser.add_argument(
        "--list-categories", action="store_true",
        help="List built-in category names and IDs without making a network request",
    )
    parser.add_argument("--page", type=int, default=1, help="First page number (default: 1)")
    parser.add_argument("--pages", type=int, default=1, help="Number of pages to fetch (default: 1)")
    parser.add_argument("--timeout", type=float, default=20, help="Timeout per page in seconds")
    args = parser.parse_args()
    if args.list_categories:
        print("Built-in category names (other categories can be supplied by numeric ID):")
        for name, category_id in sorted(CATEGORIES.items()):
            print(f"  {name:<30} {category_id}")
        print("\nOmit --category to search all categories.")
        return 0
    if args.query is None:
        parser.error("provide search text or use --list-categories")
    try:
        results = search(
            args.query, args.category, page=args.page, pages=args.pages, timeout=args.timeout
        )
    except (ValueError, SearchError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
