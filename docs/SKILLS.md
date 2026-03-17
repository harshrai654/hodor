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

## Knowledge Base Persistence Skill

Hodor also supports two optional review tools for cross-run memory:

- `query_knowledge_base`
- `save_knowledge_base`

To guide selective persistence, add a repository skill (recommended path):

```bash
mkdir -p .hodor/skills/knowledge-base-persistence
```

Create `.hodor/skills/knowledge-base-persistence/SKILL.md` with frontmatter and rules that enforce:

- query early (after inspect + changed file list)
- save late (after high-confidence conclusions)
- save only durable, high-signal learnings (architecture, stable call chain, recurring patterns)
- reject incidental details (typos, formatting, renames, temporary behavior)
- never store final PR review comments/findings text as learnings
- prioritize learnings with high reuse frequency across future reviews

Example frontmatter:

```yaml
---
name: knowledge-base-persistence
description: Save only durable, high-signal review learnings into queryable knowledge base.
---
```

## Knowledge Base Environment Variables

Configure persistence to a sibling GitHub repository:

- `HODOR_KB_REPO` (required): sibling repo slug (`owner/repo`) or clone URL
- `HODOR_KB_BRANCH` (optional): branch to sync, default `main`
- `HODOR_KB_LOCAL_PATH` (optional): local checkout path for KB repo cache
- `HODOR_KB_MAX_RESULTS` (optional): default max query results, default `6`
- `HODOR_KB_WRITE_ENABLED` (optional): `true`/`false`, default `true`
- `HODOR_KB_PUSH_ON_SAVE` (optional): `true`/`false`, default `false`
- `HODOR_KB_GITHUB_TOKEN` (optional): token for sibling repo clone/pull/push when default auth is unavailable

Startup behavior:
- Hodor runs a KB preflight before starting the agent.
- If the KB repo is unreachable or branch setup is invalid, KB tools are disabled for that run (review still continues).
- If branch is missing but writes + push-on-save are enabled, Hodor bootstraps the branch on first save.

Data layout in KB repo:

- `entries/<target-repo>.jsonl` (append/update durable learning entries)
- `indexes/<target-repo>.index.json` (compact lookup index for tags/paths/symbols)

## Troubleshooting

If skills are not used:

1. Verify files are under `.pi/skills` or `.hodor/skills` in the repository being reviewed.
2. Ensure each skill has valid frontmatter with `description`.
3. Prefer `.pi/skills/<name>/SKILL.md` with `name: <name>`.
4. Run with `--verbose` and check skill discovery logs.
