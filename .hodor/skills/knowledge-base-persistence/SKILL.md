---
name: knowledge-base-persistence
description: Save only durable, high-signal review learnings into queryable knowledge base.
---

# Knowledge Base Persistence Skill

## Purpose

Use the knowledge base tools to avoid rediscovering foundational repository behavior on each fresh PR review.

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

## Save Behavior

Do not defer all saves to the final turn. Save incrementally when confidence becomes high.

- Prefer 1-3 focused saves across the review when multiple durable learnings emerge.
- Each save should capture one reusable learning, not a summary of the whole review.
- If a previously unanswered question becomes answered through code analysis, and the answer is durable, persist it immediately with `save_knowledge_base`.
- Still perform a final pass before submission to ensure at least one strong learning was attempted for persistence.

Save only if all conditions hold:

- Learning is durable and fundamental (architecture, design invariant, service call chain, recurring coding pattern).
- Evidence is concrete and grounded in reviewed code.
- Reuse value for future PRs is clear.
- Stability is `medium` or `high`.
- Reuse frequency is likely high across future PRs in different contexts.

Use one category exactly:

- `architecture`
- `service_call_chain`
- `coding_pattern`
- `fundamental_design`

Do NOT save:

- Typos, formatting, renames, or cosmetic details.
- Temporary migrations, feature flags, or branch-specific behavior.
- Speculation without direct evidence.
- Repo trivia unlikely to help future analysis.
- Final PR review comments/findings text copied as-is.
- End-of-review verdict text as a "learning".

## Good Save Examples

- "Auth middleware always resolves tenant context before service handlers; bypassing this path breaks tenant scoping."
- "Order API writes pass through `OrderService -> PricingService -> LedgerService`; validation must happen before ledger call."
- "HTTP handlers map domain errors through `toApiError()` to preserve stable response contracts."

## Bad Save Examples

- "Variable X was renamed to Y."
- "This PR changes test fixtures in path Z."
- "Might break cache under unknown conditions."
