import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getKnowledgeBaseConfig,
  queryKnowledgeBase,
  saveKnowledgeBase,
  isHighSignalCandidate,
  checkKnowledgeBaseHealth,
} from "../src/knowledge.js";

// Mock vector-store module
vi.mock("../src/vector-store.js", () => ({
  ensureCollection: vi.fn(),
  ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  upsertPoints: vi.fn(),
  updatePayload: vi.fn(),
  searchPoints: vi.fn().mockResolvedValue([]),
  deletePoints: vi.fn(),
  checkHealth: vi.fn().mockResolvedValue(true),
  collectionExists: vi.fn().mockResolvedValue(true),
}));

// Mock embeddings module
vi.mock("../src/embeddings.js", () => ({
  embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  embedTexts: vi.fn().mockResolvedValue([new Array(1536).fill(0.1)]),
  buildEmbeddingInput: vi.fn((entry: { learning: string }) => entry.learning),
  EMBEDDING_DIMENSION: 1536,
}));

import { searchPoints, upsertPoints, updatePayload, checkHealth, collectionExists } from "../src/vector-store.js";
import { embedText } from "../src/embeddings.js";

const ENV_KEYS = [
  "HODOR_KB_ENABLED",
  "HODOR_QDRANT_URL",
  "HODOR_QDRANT_API_KEY",
  "HODOR_KB_MAX_RESULTS",
  "HODOR_KB_WRITE_ENABLED",
  "HODOR_KB_DEDUP_THRESHOLD",
  "HODOR_KB_EMBEDDING_MODEL",
  "OPENAI_API_KEY",
] as const;

const ENV_SNAPSHOT = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ENV_SNAPSHOT.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureKb(): void {
  process.env.HODOR_KB_ENABLED = "true";
  process.env.HODOR_QDRANT_URL = "https://test-qdrant.example.com";
  process.env.HODOR_QDRANT_API_KEY = "test-api-key";
  process.env.HODOR_KB_WRITE_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-openai-key";
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  resetEnv();
});

describe("knowledge base config", () => {
  it("is disabled when HODOR_KB_ENABLED is not set", () => {
    delete process.env.HODOR_KB_ENABLED;
    delete process.env.HODOR_QDRANT_URL;
    delete process.env.HODOR_QDRANT_API_KEY;
    const config = getKnowledgeBaseConfig();
    expect(config.enabled).toBe(false);
  });

  it("is disabled when Qdrant URL is missing", () => {
    process.env.HODOR_KB_ENABLED = "true";
    delete process.env.HODOR_QDRANT_URL;
    process.env.HODOR_QDRANT_API_KEY = "key";
    const config = getKnowledgeBaseConfig();
    expect(config.enabled).toBe(false);
  });

  it("is enabled when all required vars are set", () => {
    configureKb();
    const config = getKnowledgeBaseConfig();
    expect(config.enabled).toBe(true);
    expect(config.qdrantUrl).toBe("https://test-qdrant.example.com");
    expect(config.dedupThreshold).toBe(0.85);
  });

  it("respects custom dedup threshold", () => {
    configureKb();
    process.env.HODOR_KB_DEDUP_THRESHOLD = "0.85";
    const config = getKnowledgeBaseConfig();
    expect(config.dedupThreshold).toBe(0.85);
  });
});

describe("isHighSignalCandidate", () => {
  it("rejects low stability", () => {
    const result = isHighSignalCandidate({
      learning: "Some learning that is long enough for validation test purposes always",
      category: "coding_pattern",
      evidence: "Evidence that is long enough for validation",
      stability: "low",
      scope_tags: ["test"],
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("stability");
  });

  it("rejects PR verdict/judgment learnings", () => {
    const result = isHighSignalCandidate({
      learning: "In this PR, patch is incorrect and reviewer is right because this should be fixed before merge.",
      category: "coding_pattern",
      evidence: "Observed in the review output and discussion thread where maintainability comments were raised.",
      stability: "high",
      scope_tags: ["review", "verdict"],
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("judgment");
  });

  it("accepts valid high-signal learning", () => {
    const result = isHighSignalCandidate({
      learning: "Auth middleware always resolves tenant context before service handlers execute.",
      category: "architecture",
      evidence: "Confirmed in middleware chain and all protected routes in the current review.",
      stability: "high",
      scope_tags: ["auth", "tenant"],
    });
    expect(result.accepted).toBe(true);
  });
});

describe("checkKnowledgeBaseHealth", () => {
  it("returns not ok when disabled", async () => {
    delete process.env.HODOR_KB_ENABLED;
    const config = getKnowledgeBaseConfig();
    const health = await checkKnowledgeBaseHealth(config);
    expect(health.ok).toBe(false);
  });

  it("returns ok when Qdrant is reachable and collection exists", async () => {
    configureKb();
    const config = getKnowledgeBaseConfig();
    const health = await checkKnowledgeBaseHealth(config);
    expect(health.ok).toBe(true);
    expect(health.collectionReady).toBe(true);
    expect(health.writable).toBe(true);
  });

  it("returns not ok when Qdrant is unreachable", async () => {
    configureKb();
    vi.mocked(checkHealth).mockResolvedValueOnce(false);
    const config = getKnowledgeBaseConfig();
    const health = await checkKnowledgeBaseHealth(config);
    expect(health.ok).toBe(false);
    expect(health.reason).toContain("not reachable");
  });
});

describe("saveKnowledgeBase", () => {
  it("rejects low-signal learnings", async () => {
    configureKb();
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

  it("saves a new learning when no semantic duplicate exists", async () => {
    configureKb();
    vi.mocked(searchPoints).mockResolvedValueOnce([]);
    const config = getKnowledgeBaseConfig();
    const result = await saveKnowledgeBase(config, "acme/service-api", {
      learning: "Order writes always pass through OrderService before LedgerService for audit guarantees.",
      category: "service_call_chain",
      evidence: "Verified in PR diff and current service handlers where API endpoint invokes OrderService then LedgerService.",
      stability: "high",
      scope_tags: ["orders", "ledger", "audit"],
      paths: ["src/services/order.ts"],
      symbols: ["OrderService.createOrder"],
      source_pr: "https://github.com/acme/service-api/pull/42",
    });
    expect(result.status).toBe("saved");
    expect(result.ok).toBe(true);
    expect(result.entryId).toBeDefined();
    expect(upsertPoints).toHaveBeenCalledOnce();
  });

  it("merges into existing point when semantic duplicate found (score >= threshold)", async () => {
    configureKb();
    vi.mocked(searchPoints).mockResolvedValueOnce([
      {
        id: "existing-point-uuid",
        score: 0.95,
        payload: {
          target_repo: "acme/service-api",
          learning: "Order writes always go through OrderService first.",
          observations: 2,
          paths: ["src/services/order.ts"],
          symbols: ["OrderService.createOrder"],
          scope_tags: ["orders"],
          source_prs: ["https://github.com/acme/service-api/pull/40"],
        },
      },
    ]);
    const config = getKnowledgeBaseConfig();
    const result = await saveKnowledgeBase(config, "acme/service-api", {
      learning: "Order writes always pass through OrderService before LedgerService for audit guarantees.",
      category: "service_call_chain",
      evidence: "Verified in PR diff across service handler chain.",
      stability: "high",
      scope_tags: ["orders", "ledger", "audit"],
      paths: ["src/services/order.ts", "src/services/ledger.ts"],
      symbols: ["OrderService.createOrder", "LedgerService.record"],
      source_pr: "https://github.com/acme/service-api/pull/42",
    });
    expect(result.status).toBe("updated");
    expect(result.ok).toBe(true);
    expect(result.entryId).toBe("existing-point-uuid");
    expect(updatePayload).toHaveBeenCalledOnce();
    const payloadArg = vi.mocked(updatePayload).mock.calls[0][3] as Record<string, unknown>;
    expect(payloadArg.observations).toBe(3);
    expect(payloadArg.paths).toContain("src/services/ledger.ts");
    expect(payloadArg.source_prs).toContain("https://github.com/acme/service-api/pull/42");
  });
});

describe("queryKnowledgeBase", () => {
  it("returns empty when disabled", async () => {
    delete process.env.HODOR_KB_ENABLED;
    const config = getKnowledgeBaseConfig();
    const result = await queryKnowledgeBase(config, "acme/service-api", {
      query: "auth flow",
    });
    expect(result.ok).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it("returns ranked matches from Qdrant search", async () => {
    configureKb();
    vi.mocked(searchPoints).mockResolvedValueOnce([
      {
        id: "point-1",
        score: 0.88,
        payload: {
          target_repo: "acme/service-api",
          learning: "Auth middleware always resolves tenant context before handlers.",
          category: "architecture",
          evidence: "Confirmed in middleware chain.",
          stability: "high",
          scope_tags: ["auth", "tenant"],
          paths: ["src/middleware/auth.ts"],
          symbols: ["resolveTenantContext"],
          source_prs: ["https://github.com/acme/service-api/pull/9"],
        },
      },
    ]);
    const config = getKnowledgeBaseConfig();
    const result = await queryKnowledgeBase(config, "acme/service-api", {
      query: "tenant auth context flow",
      max_results: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe(0.88);
    expect(result.matches[0].learning).toContain("tenant context");
    expect(embedText).toHaveBeenCalledWith("tenant auth context flow");
  });

  it("filters by paths when specified", async () => {
    configureKb();
    vi.mocked(searchPoints).mockResolvedValueOnce([
      {
        id: "point-1",
        score: 0.85,
        payload: {
          target_repo: "acme/service-api",
          learning: "Auth middleware always resolves tenant context before handlers.",
          category: "architecture",
          evidence: "Confirmed in middleware.",
          stability: "high",
          scope_tags: ["auth"],
          paths: ["src/middleware/auth.ts"],
          symbols: [],
          source_prs: [],
        },
      },
    ]);
    const config = getKnowledgeBaseConfig();
    const noMatch = await queryKnowledgeBase(config, "acme/service-api", {
      query: "tenant auth flow",
      paths: ["src/handlers/orders.ts"],
      max_results: 3,
    });
    expect(noMatch.matches).toHaveLength(0);
  });

  it("handles embedding failure gracefully", async () => {
    configureKb();
    vi.mocked(embedText).mockRejectedValueOnce(new Error("API rate limited"));
    const config = getKnowledgeBaseConfig();
    const result = await queryKnowledgeBase(config, "acme/service-api", {
      query: "test query",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Embedding failed");
  });
});
