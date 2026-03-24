import { logger } from "./utils/logger.js";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSION = 1536;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

export { EMBEDDING_DIMENSION };

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
}

function getEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for knowledge base embeddings");
  }
  return {
    apiKey,
    model: process.env.HODOR_KB_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  };
}

async function callEmbeddingApi(
  config: EmbeddingConfig,
  input: string[],
): Promise<number[][]> {
  const url = "https://api.openai.com/v1/embeddings";
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model ?? DEFAULT_EMBEDDING_MODEL,
          input,
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          `Embedding API returned ${res.status}, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenAI embedding API error (${res.status}): ${text}`);
      }

      const body = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      return body.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          `Embedding API call failed, retrying in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("Embedding API call failed after retries");
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const config = getEmbeddingConfig();
  return callEmbeddingApi(config, texts);
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

export function buildEmbeddingInput(entry: {
  learning: string;
  evidence: string;
  scope_tags?: string[];
  paths?: string[];
  symbols?: string[];
  category?: string;
  answers_query?: string;
}): string {
  const parts = [
    entry.answers_query ? `${entry.answers_query}\n\n` : "",
    entry.category ? `[${entry.category}] ` : "",
    entry.learning,
    entry.evidence,
  ];
  if (entry.scope_tags?.length) parts.push(entry.scope_tags.join(" "));
  if (entry.paths?.length) parts.push(entry.paths.join(" "));
  if (entry.symbols?.length) parts.push(entry.symbols.join(" "));
  return parts.join(" ");
}
