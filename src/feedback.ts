import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPlatform, parsePrUrl } from "./agent.js";
import {
  fetchGithubIssueComments,
  fetchGithubReviewComments,
} from "./github.js";
import { fetchGitlabMrInfo } from "./gitlab.js";
import { parseModelString, getApiKey } from "./model.js";
import {
  isHighSignalCandidate,
  saveKnowledgeBase,
  type KnowledgeBaseConfig,
  type SaveKnowledgeInput,
} from "./knowledge.js";
import { logger } from "./utils/logger.js";
import type { Platform } from "./types.js";

export interface PrComment {
  body: string;
  author: string;
  created_at: string;
}

export interface PrConversationContext {
  comments: PrComment[];
  platform: Platform;
}

export interface FeedbackExtractionResult {
  extracted: number;
  saved: number;
  updated: number;
  rejected: number;
  errors: string[];
  learnings: string[];
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

function getTemplatesDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "..", "templates");
}

function loadFeedbackTemplate(): string {
  const templateFile = resolve(getTemplatesDir(), "feedback-extraction.md");
  return readFileSync(templateFile, "utf-8");
}

function buildFeedbackPrompt(opts: {
  prUrl: string;
  targetRepo: string;
  prConversation: string;
}): string {
  const template = loadFeedbackTemplate();
  return template
    .replace(/\{pr_url\}/g, opts.prUrl)
    .replace(/\{target_repo\}/g, opts.targetRepo)
    .replace(/\{pr_conversation\}/g, opts.prConversation);
}

// Fetches all PR comments from GitHub in chronological order,
// no Hodor-search or partitioning.
async function fetchGithubPrConversation(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrConversationContext> {
  const [issueComments, reviewComments] = await Promise.all([
    fetchGithubIssueComments(owner, repo, prNumber),
    fetchGithubReviewComments(owner, repo, prNumber),
  ]);

  const comments: PrComment[] = [];

  for (const c of issueComments) {
    if (c.body.trim().length === 0) continue;
    comments.push({
      body: c.body,
      author: c.author.username ?? c.author.name ?? "unknown",
      created_at: c.created_at,
    });
  }

  for (const r of reviewComments) {
    if (r.body.trim().length === 0) continue;
    comments.push({
      body: r.body,
      author: r.author.username ?? r.author.name ?? "unknown",
      created_at: r.submitted_at,
    });
  }

  comments.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return { comments, platform: "github" };
}

async function fetchGitlabPrConversation(
  owner: string,
  repo: string,
  mrNumber: number,
  host?: string | null,
): Promise<PrConversationContext> {
  const mrInfo = await fetchGitlabMrInfo(owner, repo, mrNumber, host, {
    includeComments: true,
  });

  const notes = mrInfo.Notes ?? [];
  const comments: PrComment[] = [];

  for (const n of notes) {
    if (n.system) continue;
    if ((n.body ?? "").trim().length === 0) continue;
    comments.push({
      body: n.body ?? "",
      author: n.author?.username ?? n.author?.name ?? "unknown",
      created_at: n.created_at ?? "",
    });
  }

  comments.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return { comments, platform: "gitlab" };
}

export async function fetchPrConversation(
  prUrl: string,
): Promise<PrConversationContext | null> {
  const platform = detectPlatform(prUrl);
  const parsed = parsePrUrl(prUrl);

  if (platform === "github") {
    return fetchGithubPrConversation(
      parsed.owner,
      parsed.repo,
      parsed.prNumber,
    );
  }

  return fetchGitlabPrConversation(
    parsed.owner,
    parsed.repo,
    parsed.prNumber,
    parsed.host,
  );
}

function formatConversationForPrompt(comments: PrComment[]): string {
  if (comments.length === 0) return "(none)";
  return comments
    .map((c) => `[${c.created_at}] @${c.author}:\n${c.body}`)
    .join("\n\n---\n\n");
}

export function parseFeedbackResponse(raw: string): SaveKnowledgeInput[] {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Feedback extraction response is not a JSON array");
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
    answers_query: item.answers_query ? String(item.answers_query) : undefined,
    signal_type: item.signal_type
      ? (String(item.signal_type) as SaveKnowledgeInput["signal_type"])
      : undefined,
  }));
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
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0;
  let cacheWriteTokens = 0,
    totalTokens = 0,
    cost = 0;

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

/**
 * Resolve model string to a pi-ai model object, matching the same logic used
 * by the review command in agent.ts.
 */
async function resolvePiModel(model: string): Promise<unknown> {
  const parsed = parseModelString(model);
  const { getModel } = await import("@earendil-works/pi-ai/compat");

  if (parsed.modelId.startsWith("arn:")) {
    const arnParts = parsed.modelId.split(":");
    const region = arnParts.length >= 4 ? arnParts[3] : "us-east-1";
    if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
      process.env.AWS_REGION = region;
    }
    return {
      id: parsed.modelId,
      name: parsed.modelId,
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    } as NonNullable<ReturnType<typeof getModel>>;
  }

  const piModel = getModel(
    parsed.provider as "anthropic" | "openai",
    parsed.modelId as never,
  );
  if (!piModel) {
    throw new Error(
      `Unsupported model "${model}": not found in pi-ai registry for provider "${parsed.provider}"`,
    );
  }
  // Verify the resolved model's provider matches what was requested,
  // since getModel may fall back to a default provider for unknown model IDs.
  const resolved = piModel as { provider?: string };
  if (resolved.provider && resolved.provider !== parsed.provider) {
    logger.warn(
      `Model "${model}" resolved to provider "${resolved.provider}" instead of "${parsed.provider}" — check if this model ID is registered in pi-ai`,
    );
  }
  return piModel;
}

export async function runFeedbackExtraction(opts: {
  config: KnowledgeBaseConfig;
  targetRepo: string;
  prUrl: string;
  model: string;
  conversationContext: PrConversationContext;
  dryRun?: boolean;
}): Promise<FeedbackExtractionResult> {
  const result: FeedbackExtractionResult = {
    extracted: 0,
    saved: 0,
    updated: 0,
    rejected: 0,
    errors: [],
    learnings: [],
  };

  if (!opts.dryRun && (!opts.config.enabled || !opts.config.writeEnabled)) {
    return result;
  }

  const { conversationContext } = opts;

  if (conversationContext.comments.length === 0) {
    logger.info("No comments found in PR conversation");
    return result;
  }

  // No KB prefetch — similarity judgment happens in saveKnowledgeBase
  // after extraction, not in the LLM prompt.

  const modelName = process.env.HODOR_KB_EXTRACT_MODEL?.trim() || opts.model;
  const parsed = parseModelString(modelName);
  const apiKey = getApiKey(modelName);
  const envSnapshot: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AWS_REGION: process.env.AWS_REGION,
  };
  if (apiKey) {
    if (parsed.provider === "anthropic") process.env.ANTHROPIC_API_KEY = apiKey;
    else if (parsed.provider === "openai") process.env.OPENAI_API_KEY = apiKey;
  }

  const conversationText = formatConversationForPrompt(
    conversationContext.comments,
  );
  const prompt = buildFeedbackPrompt({
    prUrl: opts.prUrl,
    targetRepo: opts.targetRepo,
    prConversation: conversationText,
  });

  let candidates: SaveKnowledgeInput[];
  try {
    try {
      logger.info(`Running feedback extraction with model: ${modelName}`);
      const start = Date.now();
      const piModel = await resolvePiModel(modelName);

      const {
        createAgentSession,
        SessionManager,
        SettingsManager,
        DefaultResourceLoader,
      } = await import("@earendil-works/pi-coding-agent");

      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
      });
      const cwd = process.cwd();
      const agentDir = join(cwd, ".hodor-agent");
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        systemPrompt:
          "You are a feedback analysis assistant. Respond only with JSON.",
        appendSystemPrompt: [],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalSkillPaths: [],
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model: piModel as NonNullable<
          ReturnType<typeof import("@earendil-works/pi-ai/compat").getModel>
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
      if (agentError)
        throw new Error(`Feedback extraction LLM error: ${agentError}`);

      const raw = session.getLastAssistantText() ?? "";
      const durationSeconds = Math.round((Date.now() - start) / 1000);
      const messages =
        (session as unknown as { state: { messages?: unknown[] } }).state
          ?.messages ?? [];
      const usage = sumUsageFromSessionMessages(messages);
      result.llmMetrics = { ...usage, durationSeconds };

      candidates = parseFeedbackResponse(raw);
      result.extracted = candidates.length;
      logger.info(
        `Extracted ${candidates.length} candidate learning(s) from PR conversation`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Feedback extraction LLM call failed: ${msg}`);
      logger.warn(`Feedback extraction failed: ${msg}`);
      return result;
    }

    // Straight pass-through to saveKnowledgeBase for every candidate.
    // saveKnowledgeBase handles both cases: similar entry found → update with
    // new learning text; no similar entry → insert new. No special routing needed.
    for (const candidate of candidates) {
      if (opts.dryRun) {
        const gate = isHighSignalCandidate(candidate);
        if (gate.accepted) result.saved++;
        else {
          result.rejected++;
          logger.info(`Would reject: ${gate.reason}`);
        }
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
          result.learnings.push(candidate.learning);
        } else {
          result.rejected++;
          logger.info(`Candidate rejected: ${saveResult.reason}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Save failed: ${msg}`);
        logger.warn(`Save error: ${msg}`);
      }
    }

    logger.info(
      `Feedback extraction complete: ${result.saved} saved, ${result.updated} updated, ${result.rejected} rejected`,
    );
    return result;
  } finally {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
