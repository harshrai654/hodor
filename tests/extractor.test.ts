import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseConfig } from "../src/knowledge.js";

// Mock knowledge module
vi.mock("../src/knowledge.js", () => ({
  isHighSignalCandidate: vi.fn().mockReturnValue({ accepted: true }),
  saveKnowledgeBase: vi.fn().mockResolvedValue({ ok: true, status: "saved", entryId: "test-id" }),
}));

// Mock model module
vi.mock("../src/model.js", () => ({
  parseModelString: vi.fn().mockReturnValue({ provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" }),
  getApiKey: vi.fn().mockReturnValue("test-key"),
}));

let mockSessionResponse = "[]";
let mockSessionError: string | undefined;
let mockSessionMessages: unknown[] = [];

// Mock pi-coding-agent SDK
vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn().mockImplementation(async () => ({
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      getLastAssistantText: () => mockSessionResponse,
      state: { error: mockSessionError, messages: mockSessionMessages },
      subscribe: vi.fn(),
    },
  })),
  SessionManager: { inMemory: vi.fn().mockReturnValue({}) },
  SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { isHighSignalCandidate, saveKnowledgeBase } from "../src/knowledge.js";
import { runKnowledgeExtraction } from "../src/extractor.js";

const SAMPLE_PI_MODEL = {
  id: "claude-sonnet-4-5-20250929",
  name: "claude-sonnet-4-5-20250929",
  api: "anthropic-messages-stream",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const SAMPLE_CONFIG: KnowledgeBaseConfig = {
  enabled: true,
  qdrantUrl: "https://test-qdrant.example.com",
  qdrantApiKey: "test-key",
  writeEnabled: true,
  defaultMaxResults: 6,
  embeddingModel: "text-embedding-3-small",
  dedupThreshold: 0.92,
};

const DISABLED_CONFIG: KnowledgeBaseConfig = {
  ...SAMPLE_CONFIG,
  enabled: false,
};

const SAMPLE_EXTRACTION_RESPONSE = JSON.stringify([
  {
    learning: "Auth middleware always resolves tenant context before service handlers execute downstream logic.",
    category: "architecture",
    evidence: "Confirmed in middleware chain and all protected routes in the current review diff.",
    stability: "high",
    scope_tags: ["auth", "tenant"],
    paths: ["src/middleware/auth.ts"],
    symbols: ["resolveTenantContext"],
    source_pr: "https://github.com/acme/api/pull/42",
  },
]);

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionResponse = "[]";
  mockSessionError = undefined;
  mockSessionMessages = [];
});

afterEach(() => {
  delete process.env.HODOR_KB_EXTRACT_MODEL;
});

describe("runKnowledgeExtraction", () => {
  it("returns empty result when config is disabled", async () => {
    const result = await runKnowledgeExtraction({
      config: DISABLED_CONFIG,
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [],
      reviewOutput: "{}",
    });
    expect(result.extracted).toBe(0);
    expect(result.saved).toBe(0);
  });

  it("returns empty result when writes are disabled", async () => {
    const result = await runKnowledgeExtraction({
      config: { ...SAMPLE_CONFIG, writeEnabled: false },
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [],
      reviewOutput: "{}",
    });
    expect(result.extracted).toBe(0);
    expect(result.saved).toBe(0);
  });

  it("extracts and saves learnings from SDK session response", async () => {
    mockSessionResponse = SAMPLE_EXTRACTION_RESPONSE;
    mockSessionMessages = [
      {
        role: "assistant",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { total: 0.0123 },
        },
      },
    ];

    const result = await runKnowledgeExtraction({
      config: SAMPLE_CONFIG,
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [
        { role: "user", content: "Review this PR" },
        { role: "assistant", content: "I found an auth middleware pattern." },
      ],
      reviewOutput: JSON.stringify({ findings: [], overall_correctness: "patch is correct" }),
    });

    expect(result.extracted).toBe(1);
    expect(result.saved).toBe(1);
    expect(result.llmMetrics?.totalTokens).toBe(150);
    expect(result.llmMetrics?.cost).toBeCloseTo(0.0123);
    expect(saveKnowledgeBase).toHaveBeenCalledOnce();
  });

  it("rejects candidates that fail validation", async () => {
    mockSessionResponse = SAMPLE_EXTRACTION_RESPONSE;
    vi.mocked(isHighSignalCandidate).mockReturnValueOnce({
      accepted: false,
      reason: "learning appears incidental",
    });

    const result = await runKnowledgeExtraction({
      config: SAMPLE_CONFIG,
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [],
      reviewOutput: "{}",
    });

    expect(result.extracted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.saved).toBe(0);
  });

  it("handles session error gracefully", async () => {
    mockSessionError = "model overloaded";

    const result = await runKnowledgeExtraction({
      config: SAMPLE_CONFIG,
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [],
      reviewOutput: "{}",
    });

    expect(result.extracted).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles empty extraction response", async () => {
    mockSessionResponse = "[]";

    const result = await runKnowledgeExtraction({
      config: SAMPLE_CONFIG,
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [],
      reviewOutput: "{}",
    });

    expect(result.extracted).toBe(0);
    expect(result.saved).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("strips markdown fences from LLM response", async () => {
    mockSessionResponse = "```json\n" + SAMPLE_EXTRACTION_RESPONSE + "\n```";

    const result = await runKnowledgeExtraction({
      config: SAMPLE_CONFIG,
      targetRepo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      reviewModel: "anthropic/claude-sonnet-4-5-20250929",
      reviewPiModel: SAMPLE_PI_MODEL,
      transcript: [],
      reviewOutput: "{}",
    });

    expect(result.extracted).toBe(1);
    expect(result.saved).toBe(1);
  });
});
