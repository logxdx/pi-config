---
name: visualize
description: Draw mermaid or ASCII diagrams in the terminal to explain flows, architecture, state machines, data models, sequences, or comparisons. Use when a picture would explain something faster than prose.
---

# Visualize

Draw a diagram only when it explains structure better than text: flows, call
chains, architecture, state, relationships, or timelines. Keep one idea per diagram.

## Mermaid (preferred)

Write a fenced ```mermaid block. The TUI renders it as box-drawing art.
Only these types render; anything else shows as raw source:

- `flowchart` / `graph` (use `LR` or `TD`) — processes, architecture
- `sequenceDiagram` — request/response, actors over time
- `stateDiagram-v2` — state machines
- `classDiagram` — types and relationships
- `erDiagram` — data models

Keep it under ~12 nodes with short labels (≤ 3 words). Prefer `TD` for deep
chains and `LR` for wide ones, so it fits the terminal width (~100 columns).

## ASCII (fallback)

Use a plain ``` code block for anything mermaid can't draw: tables of
comparisons, timelines, memory/stack layouts, trees, or bar sketches.

```
request ─▶ [router] ─▶ [handler] ─▶ db
                │
                └─▶ [cache] (hit → return)
```

Stay within 80 columns. Use box-drawing characters (─ │ ┌ ┐ └ ┘ ▶) consistently.

## Rules

- Follow the diagram with 1–3 sentences on what it shows. Don't restate every node.
- Never use HTML, images, or Tailwind. The terminal shows only text.
