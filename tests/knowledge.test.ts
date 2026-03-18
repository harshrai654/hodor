import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getKnowledgeBaseConfig,
  queryKnowledgeBase,
  saveKnowledgeBase,
} from "../src/knowledge.js";

const ENV_KEYS = [
  "HODOR_KB_REPO",
  "HODOR_KB_BRANCH",
  "HODOR_KB_LOCAL_PATH",
  "HODOR_KB_MAX_RESULTS",
  "HODOR_KB_WRITE_ENABLED",
  "HODOR_KB_PUSH_ON_SAVE",
  "HODOR_KB_SKIP_SYNC",
] as const;

const ENV_SNAPSHOT = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

let tempDirs: string[] = [];

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ENV_SNAPSHOT.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  resetEnv();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function createConfiguredKb(): Promise<{ configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hodor-kb-test-"));
  tempDirs.push(dir);
  process.env.HODOR_KB_REPO = "acme/reviewer-kb";
  process.env.HODOR_KB_LOCAL_PATH = dir;
  process.env.HODOR_KB_SKIP_SYNC = "true";
  process.env.HODOR_KB_WRITE_ENABLED = "true";
  process.env.HODOR_KB_PUSH_ON_SAVE = "false";
  return { configPath: dir };
}

describe("knowledge base config", () => {
  it("is disabled when repo is missing", () => {
    delete process.env.HODOR_KB_REPO;
    const config = getKnowledgeBaseConfig();
    expect(config.enabled).toBe(false);
  });
});

describe("saveKnowledgeBase", () => {
  it("rejects low-signal learnings", async () => {
    await createConfiguredKb();
    const config = getKnowledgeBaseConfig();

    const result = await saveKnowledgeBase(config, "acme/service-api", {
      learning: "rename only",
      category: "coding_pattern",
      evidence: "Short evidence.",
      stability: "low",
      scope_tags: ["api"],
    });

    expect(result.status).toBe("rejected");
    expect(result.ok).toBe(false);
  });

  it("rejects PR verdict/judgment style learnings", async () => {
    await createConfiguredKb();
    const config = getKnowledgeBaseConfig();

    const result = await saveKnowledgeBase(config, "acme/service-api", {
      learning:
        "In this PR, patch is incorrect and reviewer is right because this should be fixed before merge.",
      category: "coding_pattern",
      evidence:
        "Observed in the review output and discussion thread where maintainability comments were raised.",
      stability: "high",
      scope_tags: ["review", "verdict"],
    });

    expect(result.status).toBe("rejected");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("judgment");
  });

  it("deduplicates on matching fingerprint and updates observation count", async () => {
    const { configPath } = await createConfiguredKb();
    const config = getKnowledgeBaseConfig();
    const payload = {
      learning: "Order writes always pass through OrderService before LedgerService for audit guarantees.",
      category: "service_call_chain" as const,
      evidence: "Verified in PR diff and current service handlers where API endpoint invokes OrderService then LedgerService.",
      stability: "high" as const,
      scope_tags: ["orders", "ledger", "audit"],
      paths: ["src/services/order.ts"],
      symbols: ["OrderService.createOrder"],
      source_pr: "https://github.com/acme/service-api/pull/42",
    };

    const first = await saveKnowledgeBase(config, "acme/service-api", payload);
    const second = await saveKnowledgeBase(config, "acme/service-api", payload);

    expect(first.status).toBe("saved");
    expect(second.status).toBe("updated");
    expect(first.entryId).toBe(second.entryId);

    const entries = await readFile(join(configPath, "entries", "acme__service-api.jsonl"), "utf8");
    const parsed = entries
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { observations: number });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].observations).toBe(2);
  });
});

describe("queryKnowledgeBase", () => {
  it("returns scored matches and honors path filters", async () => {
    await createConfiguredKb();
    const config = getKnowledgeBaseConfig();

    await saveKnowledgeBase(config, "acme/service-api", {
      learning: "Auth middleware resolves tenant context before service handlers.",
      category: "architecture",
      evidence: "Observed in middleware chain and all protected routes in recent reviews.",
      stability: "medium",
      scope_tags: ["auth", "tenant"],
      paths: ["src/middleware/auth.ts"],
      symbols: ["resolveTenantContext"],
      source_pr: "https://github.com/acme/service-api/pull/9",
    });

    const query = await queryKnowledgeBase(config, "acme/service-api", {
      query: "tenant auth context flow",
      paths: ["src/middleware/auth.ts"],
      max_results: 3,
    });

    expect(query.ok).toBe(true);
    expect(query.matches.length).toBe(1);
    expect(query.matches[0].confidence).toBeGreaterThan(0);

    const noMatch = await queryKnowledgeBase(config, "acme/service-api", {
      query: "tenant auth context flow",
      paths: ["src/handlers/orders.ts"],
      max_results: 3,
    });
    expect(noMatch.matches).toHaveLength(0);
  });
});
