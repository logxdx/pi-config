---
name: pdf-reader
description: Read and comprehend PDF files (and DOCX/PPTX/XLSX), especially math lecture notes and academic papers. Use when the user asks to read, parse, analyze, or extract content from a PDF or document file.
---

# PDF Reader

Read documents as text with [liteparse](https://github.com/run-llama/liteparse): fast local parsing of the PDF text layer into markdown (headings, tables, lists). No OCR and no images: scanned pages and figures can't be read.

## Setup

Everything runs from a venv at `SKILL_DIR/.venv` with `liteparse` installed. If `SKILL_DIR/.venv/bin/lit` is missing:

```bash
python3 -m venv SKILL_DIR/.venv
SKILL_DIR/.venv/bin/pip install -r SKILL_DIR/requirements.txt
```

DOCX/PPTX/XLSX also need LibreOffice installed.

## The golden rule: parse ONCE, then search the file

Parsing re-extracts the whole document. Parse once into `doc.md`, then search and read that file — never re-parse to look something up.

```bash
python3 SKILL_DIR/scripts/pdf_parse.py <file> [--pages SPEC] [--out DIR]
```

- Writes `/tmp/pi-pdf-<name>/doc.md` with a `<!-- page N -->` marker before each page.
- Prints a triage table: `page | chars | images | flags`.
- Page specs: `1-5`, `1,3,7`, `3`, `"1-5,10"` (1-indexed).

Search the parsed file (each hit labelled with its page):

```bash
python3 SKILL_DIR/scripts/pdf_search.py /tmp/pi-pdf-<name>/doc.md "<regex>" [--context N] [--literal] [--max N]
```

Read a stretch of it with the `read` tool on `doc.md` (use offset/limit), or `grep -n '<!-- page 7 -->' doc.md` to find where page 7 starts.

## Strategy

### Step 1: Parse and triage

Run `pdf_parse.py` on every new document first. The table tells you:
- How many pages (determines strategy)
- `scanned` / `no-text` flags → no text layer; that page's content is unavailable, tell the user
- `embedded-images` / `vector-text` → figures or diagrams; only their captions and labels come through
- `garbled` → text extraction is unreliable on that page; say so when quoting it

### Step 2: Pick a strategy by size

**Short (≤15 pages):** read all of `doc.md`.

**Medium (15–60 pages):** read the first pages (abstract/intro/TOC) and skim headings (`grep -n '^#' doc.md`), then read the sections relevant to the question.

**Long (60+ pages):** don't read it all. Use headings and `pdf_search.py` to find the relevant pages, then read just those. Work section by section and tell the user about the scope.

### Step 3: Targeted lookups ("what does theorem 3.2 say?", "what's on page 7?")

1. `pdf_search.py doc.md "theorem 3\.2"` → finds the page and shows context
2. Read that page from `doc.md` (from its `<!-- page N -->` marker to the next)
3. Read the next page too when a proof or table continues

## Equations, tables and figures

Text extraction mangles math (e.g. `softmax(QKT ~~*√*~~`) and can't see figures.

- Reconstruct equations from the surrounding text and notation, write them in LaTeX, and say clearly when a formula was garbled in extraction — quote what you can read rather than guessing silently.
- Describe figures only from their captions and the text that references them; say that the figure itself isn't readable.
- Check tables against the surrounding prose when columns look misaligned.

Always note page numbers so the user can find things.

## Common patterns

### "Read/summarize this paper"
```
1. pdf_parse.py <file>          → triage table + doc.md
2. Read abstract, intro, conclusion from doc.md
3. grep -n '^#' doc.md          → section outline
4. Read key sections
5. Structured summary with page references
```

### "Explain the proof on page N"
```
1. Read page N (and N+1 for continuations) from doc.md
2. Reconstruct the math, flagging garbled parts
3. Walk through the proof step by step
```
