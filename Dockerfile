FROM node:22-slim AS builder

WORKDIR /build

# Copy package files for dependency installation
COPY package.json package-lock.json* ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code and config
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY templates ./templates

# Build the project
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Final stage
FROM node:22-slim

# Install system dependencies for PR reviews
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        jq \
        tree \
        less && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install ripgrep
RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep_15.1.0-1_amd64.deb" -o /tmp/ripgrep.deb && \
    dpkg -i /tmp/ripgrep.deb && \
    rm /tmp/ripgrep.deb

# Install GitHub CLI (gh)
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_linux_amd64.tar.gz" -o /tmp/gh.tar.gz && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv /tmp/gh_2.83.0_linux_amd64/bin/gh /usr/local/bin/ && \
    rm -rf /tmp/gh*

# Install GitLab CLI (glab)
RUN curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v1.77.0/downloads/glab_1.77.0_linux_amd64.tar.gz" -o /tmp/glab.tar.gz && \
    tar -xzf /tmp/glab.tar.gz -C /tmp && \
    mv /tmp/bin/glab /usr/local/bin/ && \
    rm -rf /tmp/glab* /tmp/bin

WORKDIR /app

# Copy built application and production deps
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/templates ./templates
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# Set wider terminal dimensions
ENV COLUMNS=200
ENV LINES=50

# Create non-root user
RUN useradd -m -u 1000 hodor && \
    chown -R hodor:hodor /app && \
    mkdir -p /workspace /tmp/hodor && \
    chown -R hodor:hodor /workspace /tmp/hodor

LABEL org.opencontainers.image.title="Hodor" \
      org.opencontainers.image.description="AI-powered code review agent for GitHub and GitLab" \
      org.opencontainers.image.url="https://github.com/mr-karan/hodor" \
      org.opencontainers.image.source="https://github.com/mr-karan/hodor" \
      org.opencontainers.image.vendor="Karan Sharma" \
      org.opencontainers.image.licenses="MIT"

USER hodor

ENV HODOR_WORKSPACE=/workspace

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
