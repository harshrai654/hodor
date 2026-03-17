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

## Save Behavior

Call `save_knowledge_base` only after review conclusions are high confidence.

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

## Good Save Examples

- "Auth middleware always resolves tenant context before service handlers; bypassing this path breaks tenant scoping."
- "Order API writes pass through `OrderService -> PricingService -> LedgerService`; validation must happen before ledger call."
- "HTTP handlers map domain errors through `toApiError()` to preserve stable response contracts."

## Bad Save Examples

- "Variable X was renamed to Y."
- "This PR changes test fixtures in path Z."
- "Might break cache under unknown conditions."
