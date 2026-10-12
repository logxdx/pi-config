#!/usr/bin/env python3
"""Search a doc.md written by pdf_parse.py; every hit is labelled with its page."""

import argparse
import re
import sys
from pathlib import Path

PAGE_MARKER = re.compile(r"^<!-- page (\d+) -->$")
MAX_LINE = 400
# liteparse's markdown escapes characters like _ and * (warmup\_steps)
MD_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>~])")


def clip(line: str, pattern: re.Pattern) -> str:
    """Keep long lines (whole paragraphs) to a window around the match."""
    if len(line) <= MAX_LINE:
        return line
    m = pattern.search(line)
    start = max(0, (m.start() if m else 0) - MAX_LINE // 2)
    end = min(len(line), start + MAX_LINE)
    return ("…" if start else "") + line[start:end] + ("…" if end < len(line) else "")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("doc", help="doc.md from pdf_parse.py")
    ap.add_argument("query", help="Regex (case-insensitive) unless --literal")
    ap.add_argument("--context", type=int, default=3, help="Lines of context (default 3)")
    ap.add_argument("--literal", action="store_true", help="Match the query literally")
    ap.add_argument("--max", type=int, default=15, help="Max hits to show (default 15)")
    args = ap.parse_args()

    lines = [MD_ESCAPE.sub(r"\1", line) for line in Path(args.doc).read_text().splitlines()]
    pattern = re.compile(re.escape(args.query) if args.literal else args.query, re.IGNORECASE)

    page_of: list[int] = []
    page = 0
    for line in lines:
        m = PAGE_MARKER.match(line)
        if m:
            page = int(m.group(1))
        page_of.append(page)

    hits = [i for i, line in enumerate(lines) if not PAGE_MARKER.match(line) and pattern.search(line)]
    if not hits:
        sys.exit(f"No matches for {args.query!r}")

    pages = sorted({page_of[i] for i in hits})
    print(f"{len(hits)} match(es) on page(s) {', '.join(map(str, pages))}")
    shown_until = -1
    for i in hits[: args.max]:
        start = max(i - args.context, shown_until + 1)
        end = min(i + args.context, len(lines) - 1)
        if start > end:
            continue
        print(f"\n── page {page_of[i]}, line {i + 1} ──")
        for j in range(start, end + 1):
            if not PAGE_MARKER.match(lines[j]):
                print(f"{'>' if j == i else ' '} {clip(lines[j], pattern)}")
        shown_until = end
    if len(hits) > args.max:
        print(f"\n… {len(hits) - args.max} more; narrow the query or raise --max")


if __name__ == "__main__":
    main()
