---
name: knowledge-base-persistence
description: Query durable prior learnings from the vector-backed knowledge base during code review.
---

# Knowledge Base Query Skill

## Purpose

Use `query_knowledge_base` to avoid rediscovering foundational repository behavior on each fresh PR review. Durable learnings are automatically extracted and persisted after each review completes — you do not need to save them yourself.

## Query Behavior

- Early in review (after inspect + changed file list), call `query_knowledge_base`.
- Ask focused questions tied to impacted areas (service layer, call chain, architectural boundary).
- Use `paths` and `symbols` filters when available to improve relevance.
- Treat returned entries as hints. Confirm with current diff and code context before concluding.
- Keep a small "knowledge question ledger" during review:
  - Mark each important question as `answered` or `unanswered`.
  - If `query_knowledge_base` returns no match, keep investigating with diff/code context.
  - Before final submission, every question must be closed with one of:
    - a concrete answer grounded in current PR evidence, or
    - an explicit "no durable answer found" conclusion (do not invent one).

## What the Knowledge Base Contains

Learnings are stored as vectors in Qdrant Cloud and retrieved via semantic similarity. Each entry includes:

- A durable fact about architecture, call chains, coding patterns, or domain design
- Category, evidence, stability rating
- Scope tags, file paths, and symbol names for filtering
- Source PRs that observed the same fact

Entries are automatically deduplicated via semantic similarity — paraphrased versions of the same fact merge into a single entry.

## What You Do NOT Need to Do

- You do **not** have a `save_knowledge_base` tool. Do not attempt to save learnings during review.
- Durable learnings are automatically extracted from the review transcript after you submit your review.
- Focus entirely on querying prior knowledge and applying it to your analysis.
