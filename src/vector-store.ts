import { logger } from "./utils/logger.js";

export interface QdrantConfig {
  url: string;
  apiKey: string;
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantFilter {
  must?: QdrantCondition[];
}

export type QdrantCondition =
  | { key: string; match: { value: string | number | boolean } }
  | { key: string; match: { any: string[] } };

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "api-key": apiKey,
  };
}

async function qdrantFetch(
  config: QdrantConfig,
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.url.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: buildHeaders(config.apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${text}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return null;
}

export async function ensureCollection(
  config: QdrantConfig,
  name: string,
  vectorSize: number,
): Promise<void> {
  try {
    await qdrantFetch(config, `/collections/${name}`, "GET");
    return;
  } catch {
    // Collection doesn't exist, create it
  }

  await qdrantFetch(config, `/collections/${name}`, "PUT", {
    vectors: {
      size: vectorSize,
      distance: "Cosine",
    },
  });
  logger.info(`Created Qdrant collection: ${name}`);
}

export async function ensurePayloadIndex(
  config: QdrantConfig,
  collection: string,
  fieldName: string,
  fieldSchema: "keyword",
): Promise<void> {
  // Qdrant requires payload indexes for filtered search on some clusters.
  // Creating an existing index is safe to treat as success (409 / already exists).
  try {
    await qdrantFetch(config, `/collections/${collection}/index`, "PUT", {
      field_name: fieldName,
      field_schema: fieldSchema,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("409") || msg.toLowerCase().includes("already exists"))
      return;
    throw err;
  }
}

export async function upsertPoints(
  config: QdrantConfig,
  collection: string,
  points: QdrantPoint[],
): Promise<void> {
  if (points.length === 0) return;
  await qdrantFetch(config, `/collections/${collection}/points`, "PUT", {
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

export async function updatePayload(
  config: QdrantConfig,
  collection: string,
  pointId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await qdrantFetch(
    config,
    `/collections/${collection}/points/payload`,
    "POST",
    {
      payload,
      points: [pointId],
    },
  );
}

export async function searchPoints(
  config: QdrantConfig,
  collection: string,
  vector: number[],
  filter: QdrantFilter | null,
  limit: number,
  scoreThreshold?: number,
): Promise<QdrantSearchResult[]> {
  const body: Record<string, unknown> = {
    vector,
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;
  if (scoreThreshold !== undefined) body.score_threshold = scoreThreshold;

  const result = (await qdrantFetch(
    config,
    `/collections/${collection}/points/search`,
    "POST",
    body,
  )) as {
    result: Array<{
      id: string;
      score: number;
      payload: Record<string, unknown>;
    }>;
  };

  return (result.result ?? []).map((hit) => ({
    id: String(hit.id),
    score: hit.score,
    payload: hit.payload ?? {},
  }));
}

export async function deletePoints(
  config: QdrantConfig,
  collection: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await qdrantFetch(
    config,
    `/collections/${collection}/points/delete`,
    "POST",
    {
      points: ids,
    },
  );
}

export async function checkHealth(config: QdrantConfig): Promise<boolean> {
  try {
    await qdrantFetch(config, "/collections", "GET");
    return true;
  } catch {
    return false;
  }
}

export async function collectionExists(
  config: QdrantConfig,
  name: string,
): Promise<boolean> {
  try {
    await qdrantFetch(config, `/collections/${name}`, "GET");
    return true;
  } catch {
    return false;
  }
}
