# Skills System for Repo-Specific Review Guidelines

Hodor supports a skills system, allowing you to customize reviews with repository-specific guidelines. This is particularly useful for:
- Project-specific coding standards
- Architecture patterns to enforce
- Common bugs to watch for
- Security requirements
- Performance considerations

## Quick Start

Create a `.hodor/skills/` directory in your repository and add markdown files:

```bash
mkdir -p .hodor/skills
```

```markdown
# .hodor/skills/conventions.md

## Architecture
- All API handlers must use the RequestValidator middleware
- Database queries must use prepared statements
- Authentication required for all /api/* endpoints

## Security
- Never log sensitive data (passwords, tokens, PII)
- All user input must be sanitized before database queries
- Rate limiting required on public endpoints
```

## Skills System Overview

Hodor automatically loads repository-specific review guidelines from your repository. Skills are discovered from the workspace and injected into the agent's system prompt when reviewing PRs.

### Supported Skill Locations

Hodor searches for skills in these locations (in priority order):

1. **`.cursorrules`** - Simple, single-file project guidelines (most common)
2. **`agents.md` or `agent.md`** - Alternative single-file location
3. **`.hodor/skills/*.md`** - Modular skills (multiple files organized by topic)

All discovered files are loaded automatically when the workspace is set up. No configuration needed—just create the files in your repository root.

### 1. Simple Skills (Single File)

Use `.cursorrules` for straightforward project guidelines:

**Location**: `.cursorrules` in repository root

**Format**:
```markdown
# Review Guidelines

Your project-specific instructions here...
```

**When Loaded**: Automatically on every PR review

**Use Case**: Project-wide conventions that apply to all PRs

### 2. Modular Skills (Multiple Files)

Use `.hodor/skills/` for organized, topic-specific guidelines:

**Location**: `.hodor/skills/TOPIC.md`

**Format**:
```markdown
# Security Review Guidelines

When reviewing security-related changes:
- Check for SQL injection vulnerabilities
- Verify authentication is required
- Ensure sensitive data is encrypted
```

**When Loaded**: Automatically with all other skills

**Use Case**: Organize guidelines by domain (security, performance, database, testing, etc.)

## Examples

### Example 1: Python Project Guidelines

**.cursorrules**:
```markdown
# Python Code Review Guidelines

## Style
- Follow PEP 8 (enforced by ruff)
- Type hints required for all public functions
- Docstrings required for classes and public methods

## Common Issues
- Check for bare `except:` clauses (should specify exception type)
- Ensure `with` statement used for file/resource handling
- Verify async functions properly await coroutines

## Testing
- Unit tests required for new features
- Test coverage must not decrease
- Mock external dependencies (APIs, databases)

## Security
- Never use `eval()` or `exec()`
- Validate all user inputs
- Use parameterized queries (never string concatenation for SQL)
```

### Example 2: JavaScript/TypeScript Project

**agents.md**:
```markdown
# Frontend Code Review Standards

## React Components
- Use functional components with hooks (no class components)
- PropTypes or TypeScript interfaces required
- Extract reusable logic into custom hooks
- Memoize expensive computations with useMemo/useCallback

## State Management
- Use React Query for server state
- Use Context for global UI state only
- Don't store derived data in state

## Performance
- Lazy load routes with React.lazy()
- Optimize images (WebP format, appropriate sizes)
- Check bundle size impact

## Common Bugs
- Check for missing dependency arrays in useEffect
- Verify exhaustive deps in useCallback/useMemo
- Look for potential infinite render loops
```

### Example 3: Security-Focused Review

**.hodor/skills/security.md**:
```markdown
# Security Review Checklist

When reviewing security-related code:

## Authentication
- [ ] Passwords hashed with bcrypt/argon2 (never MD5/SHA1)
- [ ] Session tokens are cryptographically random
- [ ] Token expiry implemented
- [ ] Rate limiting on login endpoints

## Authorization
- [ ] User permissions checked before operations
- [ ] No IDOR vulnerabilities (user can't access others' data)
- [ ] Admin checks on privileged operations

## Input Validation
- [ ] All user input validated and sanitized
- [ ] SQL injection prevented (parameterized queries)
- [ ] XSS prevented (proper escaping)
- [ ] File upload restrictions (type, size, content validation)

## Sensitive Data
- [ ] No secrets in code (use environment variables)
- [ ] Sensitive data not logged
- [ ] HTTPS enforced for sensitive operations
- [ ] Secure cookie flags set (HttpOnly, Secure, SameSite)
```

### Example 4: Database Review

**.hodor/skills/database.md**:
```markdown
# Database Change Review

## Schema Changes
- [ ] Migration is reversible (has down migration)
- [ ] Indexes added for foreign keys
- [ ] No breaking changes without deprecation period
- [ ] Column names follow naming convention

## Query Performance
- [ ] No N+1 query patterns
- [ ] Appropriate indexes for WHERE/JOIN clauses
- [ ] LIMIT used for potentially large result sets
- [ ] Explain plan checked for slow queries

## Data Integrity
- [ ] Foreign key constraints defined
- [ ] NOT NULL constraints where appropriate
- [ ] Unique constraints on natural keys
- [ ] Default values make sense
```

## How Hodor Loads Skills

When Hodor starts a review:

1. **Workspace Setup**: Clone repo and checkout PR branch
2. **Skill Discovery**: Scans workspace for:
   - `.cursorrules` (simple, single-file guidelines)
   - `agents.md` or `agent.md` (alternative single-file location)
   - `.hodor/skills/*.md` (modular, multi-file guidelines)
3. **Context Building**: Discovered skills are appended to the agent's system prompt
4. **Review**: Agent uses combined guidelines as part of its analysis

**Implementation Details**:
- Skills are loaded from the repository being reviewed (not from Hodor's own repo)
- All skills are treated as "repository skills" (always active)
- Verbose mode (`--verbose`) logs which skills were discovered and loaded

## Best Practices

### DO:
- Keep guidelines concise and actionable
- Focus on project-specific patterns (not general best practices)
- Include examples of bad patterns to avoid
- Update skills as project evolves

### DON'T:
- Don't duplicate general coding advice (Hodor already knows this)
- Don't make guidelines too long (AI context limits)
- Don't include outdated or deprecated patterns
- Don't overlap skills (consolidate related guidelines)

## Testing Your Skills

Test your skills locally before committing:

```bash
# Review a PR with your local skills
cd /path/to/your/repo
bun run dist/cli.js https://github.com/owner/repo/pull/123 --workspace . --verbose

# The verbose flag will show which skills were loaded
```

## Troubleshooting

### Skills Not Loading?

1. Check file location (must be in repo root or `.hodor/skills/`)
2. Verify filename (`.cursorrules`, `agents.md`, or `.hodor/skills/*.md`)
3. Ensure files are in the repository being reviewed (not in Hodor's repo)
4. Run with `--verbose` and check agent logs for skill discovery

### Skills Too Generic?

Remember: Hodor already knows general best practices. Your skills should focus on:
- Project-specific architecture patterns
- Common bugs in YOUR codebase
- Team conventions and standards
- Domain-specific requirements (finance, healthcare, etc.)
