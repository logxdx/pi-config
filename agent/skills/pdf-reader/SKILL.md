---
name: pdf-reader
description: Read PDFs and documents (DOCX/PPTX/XLSX, images), including math lecture notes and academic papers, page by page without flooding context. Use when the user asks to read, summarize, search, analyze, or extract content from a PDF or document file.
---

# PDF Reader

Use the `pdf` command (if it is not found, use `~/.pi/agent/skills/pdf-reader/pdf`). It wraps `liteparse`, caches results, and limits every output. Read documents only through it, never `cat` a whole parse.

```bash
pdf map FILE              # step 1, always: one row per page + fast text parse (no OCR)
pdf ocr FILE              # OCR the pages map marked OCR (or: pdf ocr FILE 4,9-12)
pdf outline FILE          # headings with page numbers (pdf outline FILE 4 = deeper)
pdf find FILE REGEX       # case-insensitive search, one line per match: "p12: ..."
pdf page FILE N           # read one page; long pages say how to continue
pdf shot FILE N           # PNG of page N; read the printed path to see the page
```

## How to work

1. `pdf map FILE`. Columns: `chars` (size of the page's text), `ocr` (`OCR` = no usable text until OCR'd), `cols`, `tables`, `figs`, `flags`. This shows where the content is and which pages are hard.
2. If pages are marked `OCR` and you need them: `pdf ocr FILE`. Skip it for a quick first look.
3. Find what you need with `pdf outline` and `pdf find`, then read only those pages with `pdf page`. Read the next page too when a table or proof continues.
4. Use `pdf shot` for figures, charts, garbled math, or to check a table.

## Notes

- Cite page numbers. Say when text came from OCR: it can have misread characters and no headings or tables.
- Garbled math: rebuild it in LaTeX from `pdf shot` and flag anything unreadable.
- Encrypted file: set `PDF_PASSWORD=...` before the command.
- DOCX/PPTX/XLSX need LibreOffice.
