# Feedback Learning Extraction

You are analyzing human feedback on an AI code review. Your job is to extract **0–5 durable, reusable learnings** from the feedback that correct, clarify, or confirm the AI reviewer's understanding of the codebase.

**IMPORTANT: Be extremely selective.** Only extract learnings you are highly confident about. When in doubt, return an empty array. A false positive (saving wrong or low-quality knowledge) is far worse than a false negative (missing a learning that could be captured later).

## Input

**PR URL:** {pr_url}
**Target Repository:** {target_repo}

### Prior Discussion (comments posted before the review — read-only context)

{pre_review_context}

### Hodor's Review

{hodor_review}

### Human Feedback (comments posted after the review)

{feedback_comments}

## What to Extract

Analyze each **post-review feedback comment** and determine how it relates to Hodor's review findings. The prior discussion is provided only as context to help you understand the conversation — do NOT extract learnings from it directly.

Focus on extracting learnings **only** when the feedback:

1. **Corrects** a review finding — the reviewer was factually wrong about how the code works, and the human explains the correct behavior with specifics (function names, call paths, invariants)
2. **Clarifies** architecture or design — the human provides new architectural or structural context about the codebase that would help future reviews of the same repository
3. **Confirms** a non-obvious pattern — the human validates a finding AND explains the broader convention/invariant behind it that generalizes beyond this PR

## Confidence Requirements

For each candidate learning, ask yourself:

- **Is this a durable fact about the codebase?** If the learning could become stale after a single refactor, skip it.
- **Is the evidence concrete and specific?** Vague feedback like "that's handled elsewhere" without naming where is insufficient.
- **Would a future reviewer of this repo benefit from knowing this?** If it only helps understand this specific PR, skip it.
- **Does the feedback author demonstrate authority?** Corrections should come with specific code references, function names, or call chain descriptions — not just disagreement.

If ANY of these checks fail, do NOT include the candidate.

## Classification Rules

For each piece of feedback, classify it as one of:

- `correction`: Hodor's finding was factually wrong. The human explains the correct behavior with specific evidence. Extract the **correct** behavior as the learning.
- `clarification`: Feedback adds new architectural/design context not present in the review. Extract only if the explanation is specific enough to be actionable.
- `confirmation`: Feedback validates a finding and explains the broader convention. Extract only if the explanation reveals a durable invariant or pattern.
- `irrelevant`: Everything else — skip entirely.

## Strict Rejection Criteria — DO NOT extract if ANY of these apply

- Subjective opinions or style preferences ("I think this approach is better", "we prefer X over Y")
- Temporary workarounds or sprint-scoped explanations ("we're fixing this next sprint", "this is a known issue")
- Feedback that simply agrees/disagrees without explaining why or providing evidence
- PR-specific details that won't generalize to future reviews of the same repository
- Duplicates of what Hodor already correctly identified in the review
- Feedback that refers to code not visible in the PR diff or review
- Vague or hand-wavy explanations ("it's handled somewhere", "there's a guard for that")
- Feedback about test coverage, documentation, or non-functional concerns unless it reveals a structural invariant
- Conversational noise ("thanks", "good catch", "LGTM", emoji-only responses)
- Feedback where the correction itself might be wrong (conflicting information, uncertain language like "I think", "maybe", "probably")

## Output Format

Respond with a JSON array. Each element must match this schema:

```json
[
  {
    "learning": "<durable fact, ≥40 chars, uses factual signal words like 'always', 'must', 'before', 'after', 'through', 'uses', 'returns', 'maps'>",
    "category": "architecture | coding_pattern | service_call_chain | fundamental_design",
    "evidence": "<the specific feedback quote or paraphrase that supports this learning, ≥30 chars>",
    "stability": "medium | high",
    "scope_tags": ["<1-5 topic tags>"],
    "paths": ["<relevant file paths mentioned in feedback or review>"],
    "symbols": ["<relevant function/class/variable names>"],
    "source_pr": "{pr_url}"
  }
]
```

## Stability Guidelines

- `high`: The feedback corrects a clear factual error with specific evidence, or describes a well-established convention backed by concrete code references
- `medium`: The feedback provides useful structural context but the author's certainty or the pattern's scope is unclear

**Default to `medium` unless the evidence is very strong.**

If no durable learnings can be confidently extracted from the feedback, return an empty array: `[]`

Returning an empty array is perfectly acceptable and preferred over extracting low-quality learnings.

Respond ONLY with the JSON array. No explanation, no markdown fences, no preamble.
