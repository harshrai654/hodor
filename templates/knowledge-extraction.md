# Knowledge Extraction

You are given a code review transcript and its final review output. Your job is to extract **0–5 durable, reusable learnings** about the reviewed repository's architecture, design, patterns, or service flows.

## Input

**PR URL:** {pr_url}
**Target Repository:** {target_repo}

### Review Transcript (abbreviated)

{transcript}

### Review Output

{review_output}

---

## Your Goal

A future reviewer will query a knowledge base with questions like:

- _"How does authentication flow through the service layer?"_
- _"What pattern governs MongoDB access in this repo?"_
- _"How should errors be thrown in service classes?"_
- _"What is the correct way to export a service singleton?"_

Each learning you extract must be a **direct, complete answer to a question like those above** — grounded in something the review transcript confirmed about the codebase. If you cannot phrase a candidate learning as a specific question a future reviewer would actually ask, discard it.

---

## What to Extract

Extract learnings that describe **how this repository permanently works** — its load-bearing design constraints, recurring implementation contracts, and stable call-chain behavior. Each learning must be:

- A durable fact about **how the code is structured or behaves**, not an observation about this PR
- Grounded in concrete evidence from the review transcript (file paths, function names, or observed code behavior)
- Specific enough that a reviewer could apply it to unrelated future PRs in the same repo
- Phrased as a **declarative statement of established behavior**, not a recommendation or criticism

---

## Categories (use exactly one per learning)

- `architecture`: core system boundaries, invariants, or fundamental design constraints
- `service_call_chain`: stable multi-step execution flows across services/modules
- `coding_pattern`: recurring implementation patterns, guards, or contracts used across the codebase
- `fundamental_design`: foundational domain/data model behaviors that affect many features

---

## Quality Bar — Good vs Bad

**BAD — too vague, not answerable:**

> "Services use async/await"
> "The repository pattern is used for data access"

**BAD — this is a review finding, not a codebase fact:**

> "The PR's UserService is missing a null check"
> "This service doesn't follow the singleton export pattern"
> "Error handling was found to be incomplete in this change"

**GOOD — specific, answerable, durable:**

> "All service classes in `server/api/services/` must export a singleton instance via `export default new ClassName()` — any method used as a callback must be pre-bound in the constructor to preserve `this` context"
> "MongoDB access must always go through a Repository class in `server/api/repositories/`; direct Mongoose model usage in services or controllers violates the data access contract"
> "Custom error classes in `server/api/services/helpers/errors/` must be thrown instead of generic `Error` — callers and middleware rely on the custom type for error classification and HTTP status mapping"

The difference: a good learning names the specific directory, class, or mechanism and explains _why_ the contract exists, not just that it does.

---

## Rejection Criteria — DO NOT extract if any apply

**Review artifact contamination (most common failure — check every candidate):**

- The learning mentions or implies a problem, bug, issue, violation, or fix found in this PR
- The learning uses language like "should", "must be fixed", "was missing", "the PR introduces", "this change", "the author", "as noted", "the finding"
- The learning is only true because of something this PR changed or broke — it is not a pre-existing codebase fact
- The learning describes what a reviewer said, recommended, or flagged

**Insufficient durability:**

- Temporary branch behavior or one-off implementation details
- Speculative — not confirmed by concrete code evidence in the transcript
- Stability would be rated "low" (likely to change soon)

**Insufficient specificity:**

- Vague truisms that apply to any JavaScript/TypeScript codebase
- Cosmetic or style observations (formatting, naming preferences without structural consequence)
- Learning text shorter than 60 characters
- Evidence text shorter than 40 characters
- No specific file paths, class names, or function names anchoring the claim

---

## Output Format

Respond with a JSON array. Each element must match this schema exactly:

```json
[
  {
    "answers_query": "<the specific question a future reviewer would ask that this learning answers, ≥10 words>",
    "learning": "<durable declarative fact, ≥60 chars, uses signal words: 'always', 'must', 'before', 'after', 'through', 'uses', 'returns', 'maps', 'requires', 'never'>",
    "category": "architecture | coding_pattern | service_call_chain | fundamental_design",
    "evidence": "<concrete evidence from the review transcript: file paths, function names, or observed code behavior, ≥40 chars>",
    "stability": "medium | high",
    "scope_tags": ["<1-5 topic tags>"],
    "paths": ["<relevant file paths observed in the review>"],
    "symbols": [
      "<relevant function/class/variable names observed in the review>"
    ],
    "source_pr": "{pr_url}"
  }
]
```

**Before finalizing each entry, apply this self-check:**

1. Could a reviewer querying `answers_query` word-for-word find this learning useful? If no, discard.
2. Does the `learning` field read as an established codebase fact, with no trace of PR findings or reviewer judgments? If no, discard.
3. Is the `evidence` field grounded in something the transcript actually showed (a file, a function, observed behavior)? If no, discard.

If no durable learnings survive these checks, return an empty array: `[]`

Respond ONLY with the JSON array. No explanation, no markdown fences, no preamble.
