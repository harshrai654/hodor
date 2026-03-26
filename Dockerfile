FROM oven/bun:1 AS base
WORKDIR /build

# Install dependencies into temp dirs for caching
FROM base AS install

# Dev dependencies (for build)
RUN mkdir -p /temp/dev
COPY package.json bun.lock* package-lock.json* /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile 2>/dev/null || cd /temp/dev && bun install

# Production dependencies only
RUN mkdir -p /temp/prod
COPY package.json bun.lock* package-lock.json* /temp/prod/
RUN cd /temp/prod && (bun install --frozen-lockfile --production 2>/dev/null || bun install --production)

# Build stage
FROM base AS build
COPY --from=install /temp/dev/node_modules node_modules
COPY tsconfig.json tsup.config.ts package.json ./
COPY src ./src
COPY templates ./templates
RUN bun run build

# Build inspect CLI (used by the agent runtime)
FROM rust:1.83-slim AS inspect-build
ARG INSPECT_GIT_URL="https://github.com/Ataraxy-Labs/inspect"
ARG INSPECT_GIT_REV=""

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        pkg-config \
        libssl-dev && \
    rm -rf /var/lib/apt/lists/*

RUN set -euo && \
    if [ -n "${INSPECT_GIT_REV}" ]; then \
      cargo install \
        --git "${INSPECT_GIT_URL}" \
        --rev "${INSPECT_GIT_REV}" \
        --locked \
        --root /tmp/inspect-root \
        inspect-cli ; \
    else \
      cargo install \
        --git "${INSPECT_GIT_URL}" \
        --locked \
        --root /tmp/inspect-root \
        inspect-cli ; \
    fi

# Final stage
FROM oven/bun:1-slim

# Install system dependencies for PR reviews
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        jq \
        tree \
        less \
        python3 \
        shellcheck \
        file \
        diffstat && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install ripgrep
RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep_15.1.0-1_amd64.deb" -o /tmp/ripgrep.deb && \
    dpkg -i /tmp/ripgrep.deb && \
    rm /tmp/ripgrep.deb

# Install RTK (Rust Token Killer) - version pinned with SHA256 verification
ARG RTK_VERSION="0.34.0"
ARG RTK_SHA256="a3d9dcb3866fa3a6cc795dc0fed87c88e38857b462ff369603fb0f689049ca08"

RUN curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz" -o /tmp/rtk.tar.gz && \
    echo "${RTK_SHA256}  /tmp/rtk.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/rtk.tar.gz -C /tmp && \
    mv /tmp/rtk /usr/local/bin/ && \
    rm /tmp/rtk.tar.gz && \
    rtk --version

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

# Workspace-safe entrypoint
COPY docker-entrypoint.sh /usr/local/bin/hodor-entrypoint.sh

# Copy inspect binary into the final image
COPY --from=inspect-build /tmp/inspect-root/bin/inspect /usr/local/bin/inspect

# Copy built application and production deps
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/templates ./templates
COPY --from=build /build/package.json ./

# Set wider terminal dimensions
ENV COLUMNS=200
ENV LINES=50

# Workspace for cloned repos
RUN mkdir -p /workspace /tmp/hodor && \
    chown -R bun:bun /app /workspace /tmp/hodor


USER bun

ENV HODOR_WORKSPACE=/workspace

ENTRYPOINT ["sh", "/usr/local/bin/hodor-entrypoint.sh"]
CMD ["--help"]
