"""Run one ddgs text search; print [{title, url, snippet}] as JSON. Args: query count [timelimit d|w|m|y]."""

import json
import sys

from ddgs import DDGS
from ddgs.exceptions import DDGSException


def main() -> None:
    query, count = sys.argv[1], int(sys.argv[2])
    timelimit = (sys.argv[3] if len(sys.argv) > 3 else "") or None
    try:
        results = DDGS(timeout=10).text(query, max_results=count, timelimit=timelimit)
    except DDGSException as e:
        if "no results" not in str(e).lower():
            sys.exit(f"ddgs: {e}")
        results = []
    print(json.dumps([
        {"title": r.get("title", ""), "url": r.get("href", ""), "snippet": " ".join((r.get("body") or "").split())}
        for r in results[:count]
    ]))


if __name__ == "__main__":
    main()
