import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

type JsonlEntry = {
  id?: string;
  targetRepo?: string;
  learning?: string;
  category?: "architecture" | "coding_pattern" | "service_call_chain" | "fundamental_design";
  evidence?: string;
  stability?: "low" | "medium" | "high";
  scopeTags?: string[];
  paths?: string[];
  symbols?: string[];
  sourcePr?: string;
  sourcePrs?: string[];
  createdAt?: string;
  updatedAt?: string;
  observations?: number;
};

const DEFAULT_COLLECTION = "hodor-kb";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${text}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return res.json();
  return null;
}

async function ensureQdrantCollection(opts: { qdrantUrl: string; qdrantApiKey: string; collection: string }) {
  const base = opts.qdrantUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", "api-key": opts.qdrantApiKey };

  try {
    await fetchJson(`${base}/collections/${opts.collection}`, { method: "GET", headers });
    return;
  } catch {
    // create
  }

  await fetchJson(`${base}/collections/${opts.collection}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
  });
}

async function embedBatch(opts: { openaiApiKey: string; model: string; inputs: string[] }): Promise<number[][]> {
  const url = "https://api.openai.com/v1/embeddings";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.openaiApiKey}`,
  };

  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const body = await fetchJson(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: opts.model, input: opts.inputs }),
      });
      const parsed = body as { data: Array<{ embedding: number[]; index: number }> };
      return (parsed.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const backoff = 500 * 2 ** attempt;
      if (attempt === maxRetries - 1) throw new Error(`Embedding failed after retries: ${msg}`);
      await sleep(backoff);
    }
  }
  return [];
}

async function qdrantUpsert(opts: {
  qdrantUrl: string;
  qdrantApiKey: string;
  collection: string;
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>;
}): Promise<void> {
  const base = opts.qdrantUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", "api-key": opts.qdrantApiKey };
  await fetchJson(`${base}/collections/${opts.collection}/points`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ points: opts.points }),
  });
}

function buildEmbeddingInput(entry: {
  learning: string;
  evidence: string;
  scope_tags: string[];
  paths: string[];
}): string {
  return [entry.learning, entry.evidence, entry.scope_tags.join(" "), entry.paths.join(" ")].filter(Boolean).join(" ");
}

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

function toDeterministicUuid(input: string): string {
  // Qdrant point IDs must be UUID or unsigned integer.
  // Use a deterministic v4-like UUID derived from sha256(input) so re-runs are idempotent.
  const bytes = createHash("sha256").update(input).digest();
  const b = Buffer.from(bytes.subarray(0, 16));
  // Set UUID version (4) and variant (RFC4122)
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main() {
  const qdrantUrl = requireEnv("HODOR_QDRANT_URL");
  const qdrantApiKey = requireEnv("HODOR_QDRANT_API_KEY");
  const openaiApiKey = requireEnv("OPENAI_API_KEY");

  const collection = optEnv("HODOR_QDRANT_COLLECTION") ?? DEFAULT_COLLECTION;
  const embeddingModel = optEnv("HODOR_KB_EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL;
  const filePath = process.argv[2] ?? "learnings.jsonl";
  const batchSize = Number.parseInt(process.env.MIGRATE_BATCH_SIZE ?? "32", 10) || 32;
  const dryRun = (process.env.DRY_RUN ?? "").toLowerCase() === "true" || process.env.DRY_RUN === "1";

  console.error(`Reading ${filePath}`);
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries: JsonlEntry[] = lines.map((l) => JSON.parse(l) as JsonlEntry);

  console.error(`Parsed ${entries.length} entries`);
  await ensureQdrantCollection({ qdrantUrl, qdrantApiKey, collection });
  console.error(`Qdrant collection ready: ${collection}`);

  let migrated = 0;
  for (const batch of chunk(entries, batchSize)) {
    const prepared = batch.map((e) => {
      const legacyId = e.id?.trim() || "";
      const pointId = legacyId
        ? toDeterministicUuid(`${String(e.targetRepo ?? "")}::${legacyId}`)
        : randomUUID();
      const target_repo = String(e.targetRepo ?? "").trim().toLowerCase();
      const learning = String(e.learning ?? "").trim();
      const evidence = String(e.evidence ?? "").trim();
      const scope_tags = normalizeList(e.scopeTags);
      const paths = normalizeList(e.paths);
      const symbols = normalizeList(e.symbols);
      const source_prs = normalizeList(e.sourcePrs ?? (e.sourcePr ? [e.sourcePr] : []));
      const created_at = e.createdAt ? String(e.createdAt) : new Date().toISOString();
      const updated_at = e.updatedAt ? String(e.updatedAt) : created_at;
      const observations = typeof e.observations === "number" && Number.isFinite(e.observations) ? e.observations : 1;

      if (!target_repo || !learning || !e.category || !e.stability) {
        throw new Error(`Invalid entry missing required fields: ${JSON.stringify(e).slice(0, 200)}`);
      }

      const payload = {
        legacy_id: legacyId || undefined,
        target_repo,
        learning,
        category: e.category,
        evidence,
        stability: e.stability,
        scope_tags,
        paths,
        symbols,
        source_prs,
        created_at,
        updated_at,
        observations,
      } satisfies Record<string, unknown>;

      const embedInput = buildEmbeddingInput({ learning, evidence, scope_tags, paths });
      return { id: pointId, payload, embedInput };
    });

    const vectors = await embedBatch({
      openaiApiKey,
      model: embeddingModel,
      inputs: prepared.map((p) => p.embedInput),
    });

    const points = prepared.map((p, idx) => ({
      id: p.id,
      vector: vectors[idx],
      payload: p.payload,
    }));

    if (!dryRun) {
      await qdrantUpsert({ qdrantUrl, qdrantApiKey, collection, points });
    }

    migrated += points.length;
    console.error(`Migrated ${migrated}/${entries.length}${dryRun ? " (dry-run)" : ""}`);
  }

  console.error("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

