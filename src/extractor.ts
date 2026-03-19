import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelString } from "./model.js";
import {
  isHighSignalCandidate,
  saveKnowledgeBase,
  type KnowledgeBaseConfig,
  type SaveKnowledgeInput,
} from "./knowledge.js";
import { logger } from "./utils/logger.js";

function getTemplatesDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "..", "templates");
}

function loadExtractionTemplate(): string {
  const templateFile = resolve(getTemplatesDir(), "knowledge-extraction.md");
  return readFileSync(templateFile, "utf-8");
}

function buildExtractionPrompt(opts: {
  prUrl: string;
  targetRepo: string;
  transcript: string;
  reviewOutput: string;
}): string {
  const template = loadExtractionTemplate();
  return template
    .replace(/\{pr_url\}/g, opts.prUrl)
    .replace(/\{target_repo\}/g, opts.targetRepo)
    .replace(/\{transcript\}/g, opts.transcript)
    .replace(/\{review_output\}/g, opts.reviewOutput);
}

function truncateTranscript(
  messages: Array<{ role: string; content?: unknown }>,
  maxChars: number,
): string {
  const parts: string[] = [];
  let budget = maxChars;

  for (const msg of messages) {
    if (budget <= 0) break;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
    }
    if (!text) continue;

    const chunk = `[${msg.role}]: ${text.slice(0, Math.min(text.length, budget))}`;
    parts.push(chunk);
    budget -= chunk.length;
  }

  return parts.join("\n\n");
}

interface PiModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

function resolveExtractionModelName(reviewModel: string): string {
  return process.env.HODOR_KB_EXTRACT_MODEL?.trim() || reviewModel;
}

function resolveExtractionModel(
  modelName: string,
  reviewPiModel: PiModel,
): PiModel {
  const overrideModel = process.env.HODOR_KB_EXTRACT_MODEL?.trim();
  if (!overrideModel) return reviewPiModel;

  const parsed = parseModelString(modelName);

  // Extraction always shares the review model's provider. Clone the review
  // model and swap the ID so the correct API endpoint/key is preserved.
  // This avoids pi-ai registry lookups for model IDs the registry may not know.
  return {
    ...reviewPiModel,
    id: parsed.modelId,
    name: parsed.modelId,
    maxTokens: 4096,
  };
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

function sumUsageFromSessionMessages(messages: unknown[]): UsageTotals {
  interface MsgUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  }
  interface AssistantMsg {
    role: string;
    usage?: MsgUsage;
  }

  const all = messages as AssistantMsg[];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let cost = 0;

  for (const msg of all) {
    if (msg.role === "assistant" && msg.usage) {
      inputTokens += msg.usage.input ?? 0;
      outputTokens += msg.usage.output ?? 0;
      cacheReadTokens += msg.usage.cacheRead ?? 0;
      cacheWriteTokens += msg.usage.cacheWrite ?? 0;
      totalTokens += msg.usage.totalTokens ?? 0;
      cost += msg.usage.cost?.total ?? 0;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost,
  };
}

function parseExtractionResponse(raw: string): SaveKnowledgeInput[] {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Extraction response is not a JSON array");
  }
  return parsed.map((item: Record<string, unknown>) => ({
    learning: String(item.learning ?? ""),
    category: String(
      item.category ?? "coding_pattern",
    ) as SaveKnowledgeInput["category"],
    evidence: String(item.evidence ?? ""),
    stability: String(
      item.stability ?? "medium",
    ) as SaveKnowledgeInput["stability"],
    scope_tags: Array.isArray(item.scope_tags)
      ? item.scope_tags.map(String)
      : [],
    paths: Array.isArray(item.paths) ? item.paths.map(String) : undefined,
    symbols: Array.isArray(item.symbols) ? item.symbols.map(String) : undefined,
    source_pr: item.source_pr ? String(item.source_pr) : undefined,
  }));
}

export interface ExtractionResult {
  extracted: number;
  saved: number;
  updated: number;
  rejected: number;
  errors: string[];
  llmMetrics?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    durationSeconds: number;
  };
}

export async function checkExtractionModelConnectivity(opts: {
  reviewModel: string;
  reviewPiModel: PiModel;
}): Promise<{ ok: boolean; modelName: string; reason?: string }> {
  const modelName = resolveExtractionModelName(opts.reviewModel);

  const piModel = resolveExtractionModel(modelName, opts.reviewPiModel);

  try {
    const {
      createAgentSession,
      SessionManager,
      SettingsManager,
      DefaultResourceLoader,
    } = await import("@mariozechner/pi-coding-agent");

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      settingsManager,
      systemPrompt: "You are a healthcheck assistant. Respond with OK.",
      appendSystemPrompt: "",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model: piModel as ReturnType<
        typeof import("@mariozechner/pi-ai").getModel
      >,
      tools: [],
      customTools: [],
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
    });
    await session.prompt("Reply with OK.");

    const agentError = (session as unknown as { state: { error?: string } })
      .state?.error;
    if (agentError) {
      return {
        ok: false,
        modelName,
        reason: `Extraction model request failed: ${agentError}`,
      };
    }

    const raw = (session.getLastAssistantText() ?? "").trim();
    if (!raw) {
      return {
        ok: false,
        modelName,
        reason: "Extraction model returned empty response",
      };
    }
    return { ok: true, modelName };
  } catch (err) {
    return {
      ok: false,
      modelName,
      reason: `Extraction model connectivity failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runKnowledgeExtraction(opts: {
  config: KnowledgeBaseConfig;
  targetRepo: string;
  prUrl: string;
  reviewModel: string;
  reviewPiModel: PiModel;
  transcript: Array<{ role: string; content?: unknown }>;
  reviewOutput: string;
}): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    extracted: 0,
    saved: 0,
    updated: 0,
    rejected: 0,
    errors: [],
  };

  if (!opts.config.enabled || !opts.config.writeEnabled) {
    return result;
  }

  const modelName = resolveExtractionModelName(opts.reviewModel);

  const piModel = resolveExtractionModel(modelName, opts.reviewPiModel);

  const transcript = truncateTranscript(opts.transcript, 30_000);
  const prompt = buildExtractionPrompt({
    prUrl: opts.prUrl,
    targetRepo: opts.targetRepo,
    transcript,
    reviewOutput: opts.reviewOutput,
  });

  let candidates: SaveKnowledgeInput[];
  try {
    logger.info(`Running knowledge extraction with model: ${modelName}`);
    const start = Date.now();
    const {
      createAgentSession,
      SessionManager,
      SettingsManager,
      DefaultResourceLoader,
    } = await import("@mariozechner/pi-coding-agent");

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      settingsManager,
      systemPrompt:
        "You are a knowledge extraction assistant. Respond only with JSON.",
      appendSystemPrompt: "",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model: piModel as ReturnType<
        typeof import("@mariozechner/pi-ai").getModel
      >,
      tools: [],
      customTools: [],
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
    });

    await session.prompt(prompt);

    const agentError = (session as unknown as { state: { error?: string } })
      .state?.error;
    if (agentError) {
      throw new Error(`Extraction LLM error: ${agentError}`);
    }

    const raw = session.getLastAssistantText() ?? "";
    const durationSeconds = Math.round((Date.now() - start) / 1000);
    const messages =
      (session as unknown as { state: { messages?: unknown[] } }).state
        ?.messages ?? [];
    const usage = sumUsageFromSessionMessages(messages);
    result.llmMetrics = { ...usage, durationSeconds };

    candidates = parseExtractionResponse(raw);
    result.extracted = candidates.length;
    logger.info(`Extracted ${candidates.length} candidate learning(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Extraction LLM call failed: ${msg}`);
    logger.warn(`Knowledge extraction failed: ${msg}`);
    return result;
  }

  for (const candidate of candidates) {
    const gate = isHighSignalCandidate(candidate);
    if (!gate.accepted) {
      result.rejected++;
      logger.info(`Extraction candidate rejected: ${gate.reason}`);
      continue;
    }

    try {
      const saveResult = await saveKnowledgeBase(
        opts.config,
        opts.targetRepo,
        candidate,
      );
      if (saveResult.ok) {
        if (saveResult.status === "saved") result.saved++;
        else if (saveResult.status === "updated") result.updated++;
      } else {
        result.rejected++;
        logger.info(`Extraction candidate save skipped: ${saveResult.reason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Save failed for candidate: ${msg}`);
      logger.warn(`Extraction save error: ${msg}`);
    }
  }

  logger.info(
    `Knowledge extraction complete: ${result.saved} saved, ${result.updated} updated, ${result.rejected} rejected`,
  );
  return result;
}
