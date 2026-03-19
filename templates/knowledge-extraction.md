# Knowledge Extraction

You are given a code review transcript and its final review output. Your job is to extract **0–5 durable, reusable learnings** about the reviewed repository's architecture, design, patterns, or service flows.

## Input

**PR URL:** {pr_url}
**Target Repository:** {target_repo}

### Review Transcript (abbreviated)

{transcript}

### Review Output

{review_output}

## What to Extract

Extract learnings that a **future reviewer of the same repository** would benefit from knowing. Each learning must be:

- A durable fact about **how the code is structured or behaves** (not a one-time observation about this PR)
- Grounded in concrete evidence from the review
- Reusable across future PR reviews of the same repository
- Specific enough to be actionable (not vague truisms)

## Categories (use exactly one per learning)

- `architecture`: core system boundaries, invariants, or fundamental design constraints
- `service_call_chain`: stable multi-step execution flows across services/modules
- `coding_pattern`: recurring implementation patterns/guards used across the codebase
- `fundamental_design`: foundational domain/data model behaviors that affect many features

## Rejection Criteria — DO NOT extract if any of these apply

- PR verdicts or reviewer judgments ("patch is correct", "this should be fixed")
- Temporary branch behavior or one-off implementation details
- Cosmetic/style observations (formatting, naming preferences)
- Speculative assumptions not confirmed in code
- Learnings with stability "low"
- Learning text shorter than 40 characters
- Evidence text shorter than 30 characters

## Output Format

Respond with a JSON array. Each element must match this schema:

```json
[
  {
    "learning": "<durable fact, ≥40 chars, uses factual signal words like 'always', 'must', 'before', 'after', 'through', 'uses', 'returns', 'maps'>",
    "category": "architecture | coding_pattern | service_call_chain | fundamental_design",
    "evidence": "<concrete evidence from the review, ≥30 chars>",
    "stability": "medium | high",
    "scope_tags": ["<1-5 topic tags>"],
    "paths": ["<relevant file paths from the review>"],
    "symbols": ["<relevant function/class/variable names>"],
    "source_pr": "{pr_url}"
  }
]
```

If no durable learnings can be extracted, return an empty array: `[]`

Respond ONLY with the JSON array. No explanation, no markdown fences, no preamble.
