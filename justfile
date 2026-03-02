default:
    @just --list

# Install dependencies
sync:
    bun install

# Build the project
build:
    bun run build

# Run tests
test:
    bun run test

# Run tests in watch mode
test-watch:
    bun run test:watch

# Type check
typecheck:
    bun run typecheck

# Run all checks
check: typecheck test

# Run dev CLI
dev *ARGS:
    bun run src/cli.ts {{ARGS}}

# Review PR
review URL *ARGS:
    bun run src/cli.ts {{URL}} {{ARGS}}

# Clean build artifacts and caches
clean:
    rm -rf dist/ node_modules/.cache

# Build Docker image
docker-build:
    docker buildx build --load -t hodor:local .

# Build Docker image (no cache)
docker-build-clean:
    docker buildx build --no-cache --load -t hodor:local .

# Run with Docker
docker-run URL:
    docker run --rm \
        -e ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-} \
        -e OPENAI_API_KEY=${OPENAI_API_KEY:-} \
        -e GITHUB_TOKEN=${GITHUB_TOKEN:-} \
        -e GITLAB_TOKEN=${GITLAB_TOKEN:-} \
        hodor:local {{URL}}
