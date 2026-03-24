import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  embedText,
  buildEmbeddingInput,
  EMBEDDING_DIMENSION,
} from "./embeddings.js";
import {
  ensureCollection,
  ensurePayloadIndex,
  upsertPoints,
  updatePayload,
  searchPoints,
  checkHealth,
  collectionExists,
  type QdrantConfig,
  type QdrantFilter,
} from "./vector-store.js";
import { logger } from "./utils/logger.js";

const KB_COLLECTION = "hodor-kb";
const DEFAULT_DEDUP_THRESHOLD = 0.85;
const KB_FILTER_INDEX_FIELDS = ["target_repo"] as const;

export const QUERY_KNOWLEDGE_BASE_SCHEMA = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
    ),
    symbols: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
    ),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export const SAVE_KNOWLEDGE_BASE_SCHEMA = Type.Object(
  {
    learning: Type.String({ minLength: 1 }),
    category: Type.Union([
      Type.Literal("architecture"),
      Type.Literal("coding_pattern"),
      Type.Literal("service_call_chain"),
      Type.Literal("fundamental_design"),
    ]),
    evidence: Type.String({ minLength: 1 }),
    stability: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ]),
    scope_tags: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 20,
    }),
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
    ),
    symbols: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
    ),
    source_pr: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export interface KnowledgeBaseConfig {
  enabled: boolean;
  qdrantUrl: string;
  qdrantApiKey: string;
  writeEnabled: boolean;
  defaultMaxResults: number;
  embeddingModel: string;
  dedupThreshold: number;
}

export interface KnowledgeBaseHealth {
  ok: boolean;
  collectionReady: boolean;
  writable: boolean;
  reason?: string;
}

export interface SaveKnowledgeInput {
  learning: string;
  category:
    | "architecture"
    | "coding_pattern"
    | "service_call_chain"
    | "fundamental_design";
  evidence: string;
  stability: "low" | "medium" | "high";
  scope_tags: string[];
  paths?: string[];
  symbols?: string[];
  source_pr?: string;
  /** The specific question a future reviewer would ask that this learning answers. Used to improve embedding retrieval. */
  answers_query?: string;
  /** Source signal type for learnings extracted from post-review feedback. Stored as payload metadata. */
  signal_type?:
    | "correction"
    | "clarification"
    | "confirmation"
    | "dismissal_with_reason";
}

export interface QueryKnowledgeInput {
  query: string;
  paths?: string[];
  symbols?: string[];
  max_results?: number;
}

export interface KnowledgeQueryMatch {
  id: string;
  learning: string;
  category: SaveKnowledgeInput["category"];
  evidence: string;
  stability: SaveKnowledgeInput["stability"];
  scopeTags: string[];
  paths: string[];
  symbols: string[];
  sourcePrs: string[];
  confidence: number;
  /** The question this learning was extracted to answer, if recorded. */
  answersQuery: string;
}

export interface QueryKnowledgeResult {
  ok: boolean;
  reason?: string;
  matches: KnowledgeQueryMatch[];
}

export interface SaveKnowledgeResult {
  ok: boolean;
  status: "disabled" | "rejected" | "saved" | "updated";
  reason?: string;
  entryId?: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return value.toLowerCase() === "1" || value.toLowerCase() === "true";
}

function normalizeRepoId(targetRepo: string): string {
  return targetRepo.trim().toLowerCase();
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function mergeArrays(existing: unknown, incoming: string[]): string[] {
  const prev = Array.isArray(existing) ? (existing as string[]) : [];
  return [...new Set([...prev, ...incoming])];
}

export function isHighSignalCandidate(input: SaveKnowledgeInput): {
  accepted: boolean;
  reason?: string;
} {
  if (input.stability === "low") {
    return { accepted: false, reason: "stability must be medium or high" };
  }
  if (input.learning.trim().length < 60) {
    return {
      accepted: false,
      reason: "learning is too short — must be ≥60 chars to ensure specificity",
    };
  }
  if (input.evidence.trim().length < 40) {
    return {
      accepted: false,
      reason: "evidence is too short — must be ≥40 chars",
    };
  }
  const lowercaseLearning = input.learning.toLowerCase();
  if (
    lowercaseLearning.includes("typo") ||
    lowercaseLearning.includes("rename only") ||
    lowercaseLearning.includes("formatting") ||
    lowercaseLearning.includes("temporary")
  ) {
    return {
      accepted: false,
      reason: "learning appears incidental or non-durable",
    };
  }
  const judgementalPatterns = [
    "patch is incorrect",
    "patch is correct",
    "blocking issue",
    "overall verdict",
    "i agree",
    "i disagree",
    "reviewer is right",
    "reviewer is wrong",
    "should be fixed",
    "this pr",
    "in this pr",
  ];
  if (
    judgementalPatterns.some((pattern) => lowercaseLearning.includes(pattern))
  ) {
    return {
      accepted: false,
      reason:
        "learning appears to be a PR verdict/judgment, not a durable codebase fact",
    };
  }

  const factualSignalPatterns = [
    "always",
    "must",
    "never",
    "requires",
    "before",
    "after",
    "through",
    "uses",
    "returns",
    "maps",
    "intentionally",
    "delegated",
  ];
  if (
    !factualSignalPatterns.some((pattern) =>
      lowercaseLearning.includes(pattern),
    )
  ) {
    return {
      accepted: false,
      reason:
        "learning must express a durable behavioral/structural fact using signal words (always, must, never, requires, intentionally, delegated, etc.)",
    };
  }
  return { accepted: true };
}

export function getKnowledgeBaseConfig(): KnowledgeBaseConfig {
  const qdrantUrl = process.env.HODOR_QDRANT_URL?.trim() ?? "";
  const qdrantApiKey = process.env.HODOR_QDRANT_API_KEY?.trim() ?? "";
  const enabled =
    parseBoolean(process.env.HODOR_KB_ENABLED, false) &&
    Boolean(qdrantUrl) &&
    Boolean(qdrantApiKey);
  const writeEnabled = parseBoolean(process.env.HODOR_KB_WRITE_ENABLED, true);
  const defaultMaxResultsRaw = Number.parseInt(
    process.env.HODOR_KB_MAX_RESULTS ?? "",
    10,
  );
  const defaultMaxResults =
    Number.isFinite(defaultMaxResultsRaw) && defaultMaxResultsRaw > 0
      ? Math.min(defaultMaxResultsRaw, 20)
      : 6;
  const embeddingModel =
    process.env.HODOR_KB_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  const dedupRaw = Number.parseFloat(
    process.env.HODOR_KB_DEDUP_THRESHOLD ?? "",
  );
  const dedupThreshold =
    Number.isFinite(dedupRaw) && dedupRaw > 0 && dedupRaw <= 1
      ? dedupRaw
      : DEFAULT_DEDUP_THRESHOLD;

  return {
    enabled,
    qdrantUrl,
    qdrantApiKey,
    writeEnabled,
    defaultMaxResults,
    embeddingModel,
    dedupThreshold,
  };
}

function getQdrantConfig(config: KnowledgeBaseConfig): QdrantConfig {
  return { url: config.qdrantUrl, apiKey: config.qdrantApiKey };
}

async function ensureKbCollectionAndIndexes(
  config: KnowledgeBaseConfig,
): Promise<void> {
  const qdrant = getQdrantConfig(config);
  await ensureCollection(qdrant, KB_COLLECTION, EMBEDDING_DIMENSION);
  for (const field of KB_FILTER_INDEX_FIELDS) {
    await ensurePayloadIndex(qdrant, KB_COLLECTION, field, "keyword");
  }
}

export async function checkKnowledgeBaseHealth(
  config: KnowledgeBaseConfig,
): Promise<KnowledgeBaseHealth> {
  if (!config.enabled) {
    return {
      ok: false,
      collectionReady: false,
      writable: false,
      reason:
        "Knowledge base not enabled (set HODOR_KB_ENABLED=true, HODOR_QDRANT_URL, HODOR_QDRANT_API_KEY)",
    };
  }

  const qdrant = getQdrantConfig(config);
  const reachable = await checkHealth(qdrant);
  if (!reachable) {
    return {
      ok: false,
      collectionReady: false,
      writable: false,
      reason: "Qdrant cluster is not reachable",
    };
  }

  const exists = await collectionExists(qdrant, KB_COLLECTION);
  if (!exists) {
    if (config.writeEnabled) {
      try {
        await ensureKbCollectionAndIndexes(config);
        return {
          ok: true,
          collectionReady: true,
          writable: true,
          reason: `Collection '${KB_COLLECTION}' created`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          collectionReady: false,
          writable: false,
          reason: `Failed to create collection: ${msg}`,
        };
      }
    }
    return {
      ok: true,
      collectionReady: false,
      writable: false,
      reason: `Collection '${KB_COLLECTION}' does not exist; enable writes to auto-create`,
    };
  }

  try {
    await ensurePayloadIndex(qdrant, KB_COLLECTION, "target_repo", "keyword");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      collectionReady: true,
      writable: false,
      reason: `Failed to ensure payload index: ${msg}`,
    };
  }

  return { ok: true, collectionReady: true, writable: config.writeEnabled };
}

export async function checkEmbeddingModelConnectivity(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  try {
    const vector = await embedText("knowledge embedding preflight probe");
    if (!Array.isArray(vector) || vector.length === 0) {
      return { ok: false, reason: "Embedding model returned an empty vector" };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function queryKnowledgeBase(
  config: KnowledgeBaseConfig,
  targetRepo: string,
  query: QueryKnowledgeInput,
): Promise<QueryKnowledgeResult> {
  if (!config.enabled) {
    return { ok: false, reason: "Knowledge base disabled", matches: [] };
  }

  const repoId = normalizeRepoId(targetRepo);

  let queryVector: number[];
  try {
    queryVector = await embedText(query.query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to embed query: ${msg}`);
    return { ok: false, reason: `Embedding failed: ${msg}`, matches: [] };
  }

  const mustConditions: Array<{ key: string; match: { value: string } }> = [
    { key: "target_repo", match: { value: repoId } },
  ];

  const filter: QdrantFilter = { must: mustConditions };
  const limit = query.max_results ?? config.defaultMaxResults;

  const qdrant = getQdrantConfig(config);
  try {
    const results = await searchPoints(
      qdrant,
      KB_COLLECTION,
      queryVector,
      filter,
      limit,
    );
    const matches: KnowledgeQueryMatch[] = results.map((hit) => ({
      id: hit.id,
      learning: String(hit.payload.learning ?? ""),
      category: hit.payload.category as KnowledgeQueryMatch["category"],
      evidence: String(hit.payload.evidence ?? ""),
      stability: hit.payload.stability as KnowledgeQueryMatch["stability"],
      scopeTags: (hit.payload.scope_tags as string[]) ?? [],
      paths: (hit.payload.paths as string[]) ?? [],
      symbols: (hit.payload.symbols as string[]) ?? [],
      sourcePrs: (hit.payload.source_prs as string[]) ?? [],
      confidence: Number(hit.score.toFixed(4)),
      answersQuery: String(hit.payload.answers_query ?? ""),
    }));

    const queryPaths = normalizeList(query.paths);
    const querySymbols = normalizeList(query.symbols);
    const filtered = matches.filter((m) => {
      if (queryPaths.length > 0 && !queryPaths.some((p) => m.paths.includes(p)))
        return false;
      if (
        querySymbols.length > 0 &&
        !querySymbols.some((s) => m.symbols.includes(s))
      )
        return false;
      return true;
    });

    return { ok: true, matches: filtered };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Qdrant search failed: ${msg}`);
    return { ok: false, reason: `Search failed: ${msg}`, matches: [] };
  }
}

export async function saveKnowledgeBase(
  config: KnowledgeBaseConfig,
  targetRepo: string,
  input: SaveKnowledgeInput,
): Promise<SaveKnowledgeResult> {
  if (!config.enabled) {
    return { ok: false, status: "disabled", reason: "Knowledge base disabled" };
  }
  if (!config.writeEnabled) {
    return {
      ok: false,
      status: "disabled",
      reason: "Knowledge base writes disabled by HODOR_KB_WRITE_ENABLED",
    };
  }

  const gate = isHighSignalCandidate(input);
  if (!gate.accepted) {
    return { ok: false, status: "rejected", reason: gate.reason };
  }

  const repoId = normalizeRepoId(targetRepo);

  // Prepend answers_query to the embedding input so vector search matches
  // on the question text, not just the learning body. This means a future
  // agent query phrased as a question retrieves this point more reliably.
  const baseEmbeddingInput = buildEmbeddingInput(input);

  let vector: number[];
  try {
    vector = await embedText(baseEmbeddingInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: "rejected",
      reason: `Embedding failed: ${msg}`,
    };
  }

  const qdrant = getQdrantConfig(config);
  const now = new Date().toISOString();

  try {
    await ensureKbCollectionAndIndexes(config);

    const dedupResults = await searchPoints(
      qdrant,
      KB_COLLECTION,
      vector,
      { must: [{ key: "target_repo", match: { value: repoId } }] },
      1,
      config.dedupThreshold,
    );

    if (dedupResults.length > 0) {
      const existing = dedupResults[0];
      const mergedPayload: Record<string, unknown> = {
        observations: (Number(existing.payload.observations) || 1) + 1,
        updated_at: now,
        paths: mergeArrays(existing.payload.paths, normalizeList(input.paths)),
        symbols: mergeArrays(
          existing.payload.symbols,
          normalizeList(input.symbols),
        ),
        scope_tags: mergeArrays(
          existing.payload.scope_tags,
          normalizeList(input.scope_tags),
        ),
        source_prs: mergeArrays(
          existing.payload.source_prs,
          input.source_pr ? [input.source_pr] : [],
        ),
      };
      // Promote answers_query if the existing point doesn't have one
      if (input.answers_query?.trim() && !existing.payload.answers_query) {
        mergedPayload.answers_query = input.answers_query.trim();
      }

      await updatePayload(qdrant, KB_COLLECTION, existing.id, mergedPayload);
      logger.info(
        `Merged duplicate learning into existing point ${existing.id} (score: ${existing.score.toFixed(3)})`,
      );
      return { ok: true, status: "updated", entryId: existing.id };
    }

    const pointId = randomUUID();
    await upsertPoints(qdrant, KB_COLLECTION, [
      {
        id: pointId,
        vector,
        payload: {
          target_repo: repoId,
          learning: input.learning.trim(),
          category: input.category,
          evidence: input.evidence.trim(),
          stability: input.stability,
          scope_tags: normalizeList(input.scope_tags),
          paths: normalizeList(input.paths),
          symbols: normalizeList(input.symbols),
          source_prs: input.source_pr ? [input.source_pr] : [],
          answers_query: input.answers_query?.trim() ?? "",
          ...(input.signal_type ? { signal_type: input.signal_type } : {}),
          created_at: now,
          updated_at: now,
          observations: 1,
        },
      },
    ]);

    return { ok: true, status: "saved", entryId: pointId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Knowledge base save failed: ${msg}`);
    return { ok: false, status: "rejected", reason: `Save failed: ${msg}` };
  }
}
