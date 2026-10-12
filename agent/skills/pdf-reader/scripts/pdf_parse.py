#!/usr/bin/env python3
"""Parse a document once with liteparse into a page-labelled markdown file.

Writes <out>/doc.md with a `<!-- page N -->` marker before each page (grep it,
don't re-parse) and prints a per-page triage table from `lit is-complex`.
Text layer only: no OCR, so scanned pages come out empty.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

LIT = Path(__file__).resolve().parent.parent / ".venv" / "bin" / "lit"


def lit(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([str(LIT), *args], capture_output=True, text=True)


def complexity(path: str, pages: str | None) -> list[dict]:
    args = ["is-complex", path, "--compact", "--quiet"]
    if pages:
        args += ["--target-pages", pages]
    # Exits non-zero when a page has issues; stdout is still the per-page JSON
    result = lit(*args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return []  # not a PDF (DOCX, PPTX, image…) or unreadable


def parse_pages(path: str, pages: str | None, page_numbers: list[int]) -> list[tuple[int, str]]:
    common = [path, "--quiet", "--no-ocr"]
    if pages:
        common += ["--target-pages", pages]

    md = lit("parse", *common, "--format", "markdown")
    if md.returncode == 0:
        parts = re.split(r"\n-{5}\n", md.stdout)
        numbers = page_numbers or list(range(1, len(parts) + 1))
        # Markdown separates pages with "-----"; trust it only if the count lines up
        if len(parts) == len(numbers):
            return list(zip(numbers, (p.strip() for p in parts)))

    js = lit("parse", *common, "--format", "json")
    if js.returncode != 0:
        sys.exit(f"lit parse failed: {(js.stderr or md.stderr).strip()[:500]}")
    data = json.loads(js.stdout)
    return [(int(p["page"]), p["text"].strip()) for p in data["pages"]]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", help="PDF (or DOCX/PPTX/XLSX with LibreOffice installed)")
    ap.add_argument("--pages", help='Page spec, e.g. "1-5,10" (default: all)')
    ap.add_argument("--out", help="Output directory (default: /tmp/pi-pdf-<name>)")
    args = ap.parse_args()

    if not LIT.exists():
        sys.exit(f"liteparse not installed: {LIT} missing (see Setup in SKILL.md)")
    src = Path(args.path).expanduser().resolve()
    if not src.exists():
        sys.exit(f"No such file: {src}")

    out_dir = Path(args.out) if args.out else Path(f"/tmp/pi-pdf-{re.sub(r'[^A-Za-z0-9_.-]+', '_', src.stem)}")
    out_dir.mkdir(parents=True, exist_ok=True)

    report = complexity(str(src), args.pages)
    page_numbers = [int(p["page_number"]) for p in report]
    pages = parse_pages(str(src), args.pages, page_numbers)

    doc = out_dir / "doc.md"
    doc.write_text("\n\n".join(f"<!-- page {n} -->\n{text}" for n, text in pages) + "\n")
    lines = doc.read_text().count("\n")
    print(f"Parsed {len(pages)} page(s) → {doc} ({lines} lines, {doc.stat().st_size // 1024} KB)")

    if report:
        print("\npage  chars  images  flags")
        for p in report:
            reasons = ",".join(p.get("reasons", [])) if p.get("needs_ocr") else ""
            print(f"{p['page_number']:>4}  {p.get('text_length', 0):>5}  {p.get('image_block_count', 0):>6}  {reasons}")
        scanned = [p["page_number"] for p in report if {"scanned", "no-text"} & set(p.get("reasons", []))]
        if scanned:
            print(f"\nNo text layer on page(s) {scanned} (scanned/image-only): their content can't be extracted.")


if __name__ == "__main__":
    main()
