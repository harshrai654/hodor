# Skills System (Upstream Format)

Hodor uses the upstream `@mariozechner/pi-coding-agent` skills system (`agentskills.io` style).

Skills are:

- Discovered from the reviewed repository at `.pi/skills` or `.hodor/skills`
- Advertised to the model as metadata
- Loaded lazily by the agent with the `read` tool when relevant

## Quick Start

Create a skill in the repository you want Hodor to review:

```bash
mkdir -p .pi/skills/security-review
```

```markdown
<!-- .pi/skills/security-review/SKILL.md -->
---
name: security-review
description: Security checklist for API and auth related pull requests.
---

## Authentication
- All protected endpoints must enforce auth middleware.
- Session and token checks must happen server-side.

## Input Validation
- Reject invalid payloads at API boundaries.
- Use parameterized queries for all DB access.
```

Run Hodor with verbose logs:

```bash
bun run dist/cli.js <PR_URL> --workspace . --verbose
```

## Supported Layouts

Hodor discovers skills from both `.pi/skills` and `.hodor/skills` (if either exists):

1. Flat markdown files: `.pi/skills/*.md` (or `.hodor/skills/*.md`)
2. Subdirectory skills: `.pi/skills/<skill-name>/SKILL.md` (recommended)

Use the subdirectory `SKILL.md` format when possible because it keeps one skill per folder and avoids name collisions.

## Frontmatter Requirements

Skills should include YAML frontmatter:

```yaml
---
name: security-review
description: Security checklist for API and auth related pull requests.
---
```

- `description` is required for the SDK to activate the skill.
- `name` is strongly recommended and should match the parent directory for `SKILL.md` skills.

## Behavior in Hodor

When Hodor starts a review:

1. It initializes the SDK resource loader with the review system prompt.
2. It discovers skills from `.pi/skills` and `.hodor/skills` in the reviewed repository.
3. It passes skill metadata to the agent.
4. The agent reads matching skill files on demand during review.

Hodor no longer inlines skill markdown into the system prompt and no longer uses `.cursorrules` or `AGENTS.md` as repository skills.

## Knowledge Base (Qdrant Cloud)

Hodor supports a persistent knowledge base backed by Qdrant Cloud vector search and OpenAI embeddings for semantic retrieval.

During reviews, the agent queries prior learnings via `query_knowledge_base` to leverage durable architectural and pattern knowledge. After a review completes, a separate extraction pass automatically identifies and persists new learnings from the review transcript.

### Architecture

```
Review Phase:
  Agent → query_knowledge_base → embed query (OpenAI) → Qdrant search → ranked context

Post-Review Extraction:
  Review transcript + output → extraction LLM pass → validate candidates → embed → Qdrant upsert
```

### Knowledge Base Environment Variables

Configure Qdrant Cloud connection:

- `HODOR_KB_ENABLED` (required): `true`/`false`, default `false`
- `HODOR_QDRANT_URL` (required when KB enabled): Qdrant Cloud cluster URL
- `HODOR_QDRANT_API_KEY` (required when KB enabled): API key for Qdrant Cloud
- `OPENAI_API_KEY` (required when KB enabled): used for embedding generation
- `HODOR_KB_WRITE_ENABLED` (optional): `true`/`false`, default `true`
- `HODOR_KB_MAX_RESULTS` (optional): default max query results, default `6`
- `HODOR_KB_EMBEDDING_MODEL` (optional): embedding model, default `text-embedding-3-small`
- `HODOR_KB_DEDUP_THRESHOLD` (optional): cosine similarity threshold for semantic dedup, default `0.92`
- `HODOR_KB_EXTRACT_MODEL` (optional): model override for extraction pass (e.g. `openai/gpt-4o-mini`)

Startup behavior:
- Hodor runs a KB preflight before starting the agent.
- If Qdrant is unreachable or the API key is invalid, KB tools are disabled for that run (review still continues).
- If the collection does not exist and writes are enabled, Hodor auto-creates it.

### Semantic Dedup

When saving a learning, Hodor embeds the candidate and searches Qdrant for near-duplicates (threshold >= 0.92 by default). Matching entries get their metadata merged (observation count incremented, paths/symbols/tags unioned) instead of creating duplicates. This catches paraphrased duplicates that hash-based dedup misses.

## Troubleshooting

If skills are not used:

1. Verify files are under `.pi/skills` or `.hodor/skills` in the repository being reviewed.
2. Ensure each skill has valid frontmatter with `description`.
3. Prefer `.pi/skills/<name>/SKILL.md` with `name: <name>`.
4. Run with `--verbose` and check skill discovery logs.
