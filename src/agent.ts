import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  BashSpawnContext,
  BashSpawnHook,
} from "@mariozechner/pi-coding-agent";
import { logger } from "./utils/logger.js";
import { exec } from "./utils/exec.js";
import { fetchGithubPrInfo, normalizeGithubMetadata } from "./github.js";
import { fetchGitlabMrInfo, postGitlabMrComment } from "./gitlab.js";
import { setupWorkspace, cleanupWorkspace } from "./workspace.js";
import { buildPrReviewPrompt } from "./prompt.js";
import { parseModelString, mapReasoningEffort, getApiKey } from "./model.js";
import {
  formatKnowledgeExtractionMarkdown,
  formatMetricsMarkdown,
  printMetrics,
} from "./metrics.js";
import { SUBMIT_REVIEW_SCHEMA, validateReviewOutput } from "./review.js";
import { REVIEW_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  QUERY_KNOWLEDGE_BASE_SCHEMA,
  checkKnowledgeBaseHealth,
  checkEmbeddingModelConnectivity,
  getKnowledgeBaseConfig,
  queryKnowledgeBase,
} from "./knowledge.js";
import {
  runKnowledgeExtraction,
  checkExtractionModelConnectivity,
} from "./extractor.js";
import type {
  Platform,
  ParsedPrUrl,
  ReviewMetrics,
  PostCommentResult,
  MrMetadata,
  RenderContext,
  ReviewOutput,
} from "./types.js";
import { isRtkCompatibleCommand } from "./rtk.js";

export interface AgentProgressEvent {
  type:
    | "tool_start"
    | "tool_end"
    | "thinking"
    | "turn_start"
    | "turn_end"
    | "agent_start"
    | "agent_end"
    | "text_delta"
    | "thinking_delta"
    | "tool_result";
  toolName?: string;
  toolArgs?: string;
  isError?: boolean;
  turnIndex?: number;
  delta?: string;
  result?: string;
}

async function checkRtkAvailable(): Promise<boolean> {
  try {
    await exec("rtk", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function createRtkSpawnHook(): BashSpawnHook {
  return (ctx: BashSpawnContext): BashSpawnContext => {
    const cmd = ctx.command;

    if (!isRtkCompatibleCommand(cmd)) {
      return ctx;
    }

    const trimmed = cmd.trim();
    if (trimmed === "" || trimmed.startsWith("rtk ")) {
      return ctx;
    }

    // The bash tool frequently prefixes commands with `cd <workspace> &&`.
    // We must wrap the *actual executable segment* with RTK (e.g. `cd ... && rtk git diff`),
    // not the entire shell command (which would become `rtk cd ...` and break).
    const segments = trimmed
      .split("&&")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return ctx;
    }

    const last = segments[segments.length - 1];
    const tokens = last.split(/\s+/).filter(Boolean);
    const envAssignments: string[] = [];
    let i = 0;
    for (; i < tokens.length; i++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
        envAssignments.push(tokens[i]);
        continue;
      }
      break;
    }

    const remainder = tokens.slice(i).join(" ");
    if (remainder.trim().length === 0 || remainder.trim().startsWith("rtk ")) {
      return ctx;
    }

    const wrappedLast =
      envAssignments.length > 0
        ? `${envAssignments.join(" ")} rtk ${remainder}`
        : `rtk ${remainder}`;
    segments[segments.length - 1] = wrappedLast;

    return {
      ...ctx,
      command: segments.join(" && "),
    };
  };
}

export function detectPlatform(prUrl: string): Platform {
  const url = new URL(prUrl);
  const hostname = url.hostname;
  if (prUrl.includes("/-/merge_requests/") || hostname.includes("gitlab")) {
    return "gitlab";
  }
  if (prUrl.includes("/pull/") || hostname.includes("github")) {
    return "github";
  }
  throw new Error(
    `Cannot detect platform for URL: ${prUrl}. Expected a GitHub pull request (/pull/) or GitLab merge request (/-/merge_requests/) URL.`,
  );
}

export function parsePrUrl(prUrl: string): ParsedPrUrl {
  const url = new URL(prUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const host = url.host;

  // GitHub format: /owner/repo/pull/123
  if (pathParts.length >= 4 && pathParts[2] === "pull") {
    const prNumber = parseInt(pathParts[3], 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new Error(
        `Invalid PR number in URL: ${prUrl}. Expected a positive integer after /pull/.`,
      );
    }
    return {
      owner: pathParts[0],
      repo: pathParts[1],
      prNumber,
      host,
    };
  }

  // GitLab format: /group/subgroup/repo/-/merge_requests/123
  const mrIndex = pathParts.indexOf("merge_requests");
  if (mrIndex >= 0) {
    if (mrIndex < 2 || mrIndex + 1 >= pathParts.length) {
      throw new Error(
        `Invalid GitLab MR URL format: ${prUrl}. Expected .../-/merge_requests/<number>`,
      );
    }
    if (pathParts[mrIndex - 1] !== "-") {
      throw new Error(
        `Invalid GitLab MR URL format: ${prUrl}. Missing '/-/' segment before merge_requests.`,
      );
    }

    const repo = pathParts[mrIndex - 2];
    const ownerParts = pathParts.slice(0, mrIndex - 2);
    const owner = ownerParts.length > 0 ? ownerParts.join("/") : pathParts[0];
    const prNumber = parseInt(pathParts[mrIndex + 1], 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new Error(
        `Invalid MR number in URL: ${prUrl}. Expected a positive integer after /merge_requests/.`,
      );
    }
    return { owner, repo, prNumber, host };
  }

  throw new Error(
    `Invalid PR/MR URL format: ${prUrl}. Expected GitHub pull request or GitLab merge request URL.`,
  );
}

export async function postReviewComment(opts: {
  prUrl: string;
  reviewText: string;
  model?: string | null;
  metricsFooter?: string | null;
}): Promise<PostCommentResult> {
  const { prUrl, reviewText, model, metricsFooter } = opts;
  const platform = detectPlatform(prUrl);
  logger.info(`Posting comment to ${platform} PR/MR: ${prUrl}`);

  let parsed: ParsedPrUrl;
  try {
    parsed = parsePrUrl(prUrl);
  } catch (err) {
    return { success: false, error: String(err) };
  }

  let body = reviewText;
  if (model) {
    body = `${body}\n\n---\n\nReview generated by Hodor (model: \`${model}\`)`;
  }
  if (metricsFooter) {
    body = `${body}\n\n${metricsFooter}`;
  }

  try {
    if (platform === "github") {
      await exec("gh", [
        "pr",
        "review",
        String(parsed.prNumber),
        "--repo",
        `${parsed.owner}/${parsed.repo}`,
        "--comment",
        "--body",
        body,
      ]);
      logger.info(
        `Successfully posted review to GitHub PR #${parsed.prNumber}`,
      );
      return { success: true, platform: "github", prNumber: parsed.prNumber };
    } else {
      await postGitlabMrComment(
        parsed.owner,
        parsed.repo,
        parsed.prNumber,
        body,
        parsed.host,
      );
      logger.info(
        `Successfully posted review to GitLab MR !${parsed.prNumber}`,
      );
      return {
        success: true,
        platform: "gitlab",
        mrNumber: parsed.prNumber,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to post comment: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function postFeedbackComment(opts: {
  prUrl: string;
  feedbackText: string;
  model?: string | null;
}): Promise<PostCommentResult> {
  const { prUrl, feedbackText, model } = opts;
  const platform = detectPlatform(prUrl);
  logger.info(`Posting comment to ${platform} PR/MR: ${prUrl}`);

  let parsed: ParsedPrUrl;
  try {
    parsed = parsePrUrl(prUrl);
  } catch (err) {
    return { success: false, error: String(err) };
  }

  let body = feedbackText;
  if (model) {
    body = `${body}\n\n---\n\nFeedback generated by Hodor (model: \`${model}\`)`;
  }

  try {
    if (platform === "github") {
      await exec("gh", [
        "pr",
        "comment",
        String(parsed.prNumber),
        "--repo",
        `${parsed.owner}/${parsed.repo}`,
        "--body",
        body,
      ]);
      logger.info(
        `Successfully posted feedback to GitHub PR #${parsed.prNumber}`,
      );
      return { success: true, platform: "github", prNumber: parsed.prNumber };
    } else {
      await postGitlabMrComment(
        parsed.owner,
        parsed.repo,
        parsed.prNumber,
        body,
        parsed.host,
      );
      logger.info(
        `Successfully posted feedback to GitLab MR !${parsed.prNumber}`,
      );
      return {
        success: true,
        platform: "gitlab",
        mrNumber: parsed.prNumber,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to post feedback comment: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function reviewPr(opts: {
  prUrl: string;
  model?: string;
  reasoningEffort?: string;
  customPrompt?: string | null;
  promptFile?: string | null;
  cleanup?: boolean;
  workspaceDir?: string | null;
  includeMetricsFooter?: boolean;
  onEvent?: (event: AgentProgressEvent) => void;
}): Promise<{
  review: ReviewOutput;
  metricsFooter: string | null;
  renderContext: RenderContext;
}> {
  const {
    prUrl,
    model = "anthropic/claude-sonnet-4-5-20250929",
    reasoningEffort,
    customPrompt,
    promptFile,
    cleanup = true,
    workspaceDir,
    includeMetricsFooter = false,
    onEvent,
  } = opts;

  logger.info(`Starting PR review for: ${prUrl}`);

  // Parse PR URL
  const { owner, repo, prNumber, host } = parsePrUrl(prUrl);
  const platform = detectPlatform(prUrl);
  logger.info(
    `Platform: ${platform}, Repo: ${owner}/${repo}, PR: ${prNumber}, Host: ${host}`,
  );

  // --- Preflight: validate model + credentials before any expensive I/O ---
  const parsed = parseModelString(model);
  const thinkingLevel = mapReasoningEffort(reasoningEffort);

  // Resolve API key (throws if missing for non-bedrock providers)
  const apiKey = getApiKey(model);

  // Note: For bedrock, we don't preflight-check AWS credentials because the
  // SDK resolves them from many sources (env vars, IMDS, ECS task role, IRSA,
  // ~/.aws/credentials, etc.) and we can't reliably detect all of them.
  // If credentials are missing, the SDK will fail with a clear error.

  // Snapshot env vars we may mutate, restore in finally block
  const envSnapshot: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AWS_REGION: process.env.AWS_REGION,
  };

  // Set API key in environment for pi-ai early so session creation can use it
  if (apiKey) {
    if (parsed.provider === "anthropic") {
      process.env.ANTHROPIC_API_KEY = apiKey;
    } else if (parsed.provider === "openai") {
      process.env.OPENAI_API_KEY = apiKey;
    }
  }

  // Import pi SDK
  const {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    createReadTool,
    createBashTool,
    createGrepTool,
    createFindTool,
    createLsTool,
  } = await import("@mariozechner/pi-coding-agent");
  const { getModel } = await import("@mariozechner/pi-ai");

  // Resolve model — use registry for known models, construct manually for custom ARNs
  let piModel: ReturnType<typeof getModel>;
  if (parsed.modelId.startsWith("arn:")) {
    // Custom bedrock ARN (inference profile, cross-region, etc.)
    // Extract region from ARN: arn:aws:bedrock:<region>:<account>:...
    const arnParts = parsed.modelId.split(":");
    const region = arnParts.length >= 4 ? arnParts[3] : "us-east-1";
    // Set AWS_REGION so the BedrockRuntimeClient uses the correct endpoint
    if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
      process.env.AWS_REGION = region;
    }
    piModel = {
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
    } as ReturnType<typeof getModel>;
    logger.info(`Custom bedrock ARN model — region: ${region}`);
  } else {
    try {
      piModel = getModel(
        parsed.provider as "anthropic",
        parsed.modelId as never,
      );
    } catch (err) {
      throw new Error(
        `Unsupported model "${model}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  logger.info("Preflight OK — model and credentials validated");

  const rtkAvailable = await checkRtkAvailable();
  if (rtkAvailable) {
    logger.info(
      "RTK preflight OK — bash commands will be wrapped for token savings",
    );
  } else {
    logger.info("RTK not available — using standard bash execution");
  }

  const targetRepo = `${owner}/${repo}`;
  let knowledgeBaseConfig = getKnowledgeBaseConfig();
  if (knowledgeBaseConfig.enabled) {
    try {
      const kbHealth = await checkKnowledgeBaseHealth(knowledgeBaseConfig);
      if (!kbHealth.ok) {
        logger.warn(
          `Knowledge base disabled for this run: ${kbHealth.reason ?? "health check failed"}`,
        );
        knowledgeBaseConfig = { ...knowledgeBaseConfig, enabled: false };
      } else if (kbHealth.reason) {
        logger.info(`Knowledge base preflight: ${kbHealth.reason}`);
      } else {
        logger.info(
          `Knowledge base preflight OK (collection: ${
            kbHealth.collectionReady ? "ready" : "will create on first save"
          }, writable: ${kbHealth.writable})`,
        );
      }
    } catch (err) {
      logger.warn(`Knowledge base preflight failed, disabling tools: ${err}`);
      knowledgeBaseConfig = { ...knowledgeBaseConfig, enabled: false };
    }
  }

  // Preflight: embedding model connectivity (required for both query and save)
  if (knowledgeBaseConfig.enabled) {
    try {
      const embCheck = await checkEmbeddingModelConnectivity();
      if (!embCheck.ok) {
        logger.warn(
          `Embedding model preflight failed, disabling KB: ${embCheck.reason}`,
        );
        knowledgeBaseConfig = { ...knowledgeBaseConfig, enabled: false };
      } else {
        logger.info("Embedding model preflight OK");
      }
    } catch (err) {
      logger.warn(`Embedding model preflight error, disabling KB: ${err}`);
      knowledgeBaseConfig = { ...knowledgeBaseConfig, enabled: false };
    }
  }

  // Preflight: extraction model connectivity (required for post-review knowledge save)
  if (knowledgeBaseConfig.enabled && knowledgeBaseConfig.writeEnabled) {
    try {
      const extCheck = await checkExtractionModelConnectivity({
        reviewModel: model,
        reviewPiModel: piModel,
      });
      if (!extCheck.ok) {
        logger.warn(
          `Extraction model preflight failed (${extCheck.modelName}), disabling KB writes: ${extCheck.reason}`,
        );
        knowledgeBaseConfig = { ...knowledgeBaseConfig, writeEnabled: false };
      } else {
        logger.info(`Extraction model preflight OK (${extCheck.modelName})`);
      }
    } catch (err) {
      logger.warn(
        `Extraction model preflight error, disabling KB writes: ${err}`,
      );
      knowledgeBaseConfig = { ...knowledgeBaseConfig, writeEnabled: false };
    }
  }
  // --- End preflight ---
  // Setup workspace
  const { workspace, targetBranch, diffBaseSha, isTemporary } =
    await setupWorkspace({
      platform,
      owner,
      repo,
      prNumber: String(prNumber),
      host,
      workingDir: workspaceDir ?? undefined,
      reuse: workspaceDir != null,
    });

  const workspacePath = workspace;

  try {
    // Fetch PR metadata
    let mrMetadata: MrMetadata | null = null;
    if (platform === "gitlab") {
      try {
        mrMetadata = await fetchGitlabMrInfo(owner, repo, prNumber, host, {
          includeComments: true,
        });
      } catch (err) {
        logger.warn(`Failed to fetch GitLab metadata: ${err}`);
      }
    } else if (platform === "github") {
      try {
        const githubRaw = await fetchGithubPrInfo(owner, repo, prNumber);
        mrMetadata = normalizeGithubMetadata(githubRaw);
      } catch (err) {
        logger.warn(`Failed to fetch GitHub metadata: ${err}`);
      }
    }

    // Build prompt (always uses JSON template; rendered to markdown post-hoc)
    const prompt = buildPrReviewPrompt({
      prUrl,
      platform,
      targetBranch,
      diffBaseSha,
      mrMetadata,
      customInstructions: customPrompt,
      customPromptFile: promptFile,
    });

    const startTime = Date.now();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const skillPaths = [
      join(workspacePath, ".pi", "skills"),
      join(workspacePath, ".hodor", "skills"),
    ].filter((p) => existsSync(p));
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspacePath,
      settingsManager,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      appendSystemPrompt: "",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: skillPaths,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await resourceLoader.reload();
    const { skills, diagnostics: skillDiagnostics } =
      resourceLoader.getSkills();
    if (skills.length > 0) {
      logger.info(`Discovered ${skills.length} repository skill(s)`);
      for (const skill of skills) {
        logger.info(`Found skill: ${skill.name} (${skill.filePath})`);
      }
    }
    for (const diagnostic of skillDiagnostics) {
      const path = diagnostic.path ? ` (${diagnostic.path})` : "";
      logger.warn(`Skill diagnostic: ${diagnostic.message}${path}`);
    }

    let submittedReview: ReviewOutput | null = null;
    let kbQueryCalls = 0;
    let kbNoMatchResponses = 0;
    let submitReviewCalls = 0;
    let kbCurrentPrMatchReturned = false;

    const hasPriorReviewFeedback = Boolean(
      (mrMetadata?.reviewerSummaries?.length ?? 0) > 0 ||
      (mrMetadata?.inlineReviewComments?.length ?? 0) > 0,
    );
    const submitReviewTool: ToolDefinition = {
      name: "submit_review",
      label: "Submit Review",
      description:
        "Submit the final structured review after the analysis is complete.",
      parameters: SUBMIT_REVIEW_SCHEMA,
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        submitReviewCalls++;
        if (submittedReview) {
          logger.warn(
            "Agent called submit_review more than once; ignoring duplicate submission",
          );
          return {
            content: [
              {
                type: "text",
                text: "Review already submitted. Do not call submit_review again.",
              },
            ],
            details: { ignoredDuplicate: true },
          };
        }

        let candidate: ReviewOutput;
        try {
          candidate = validateReviewOutput(params as ReviewOutput);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Rejected submit_review payload: ${message}`);
          return {
            content: [
              {
                type: "text",
                text: `Invalid submit_review payload: ${message}. Fix the payload and call submit_review again once.`,
              },
            ],
            details: { ok: false, reason: message },
          };
        }

        if (
          kbQueryCalls > 0 &&
          kbNoMatchResponses > 0 &&
          !candidate.kb_question_closure?.trim()
        ) {
          return {
            content: [
              {
                type: "text",
                text: "submit_review requires `kb_question_closure` because earlier `query_knowledge_base` calls returned no matches. Add an evidence-backed closure note and call submit_review again.",
              },
            ],
            details: {
              ok: false,
              reason:
                "missing kb_question_closure after no-match knowledge queries",
              kbQueryCalls,
              kbNoMatchResponses,
            },
          };
        }

        if (
          hasPriorReviewFeedback &&
          (!candidate.prior_feedback_resolution ||
            candidate.prior_feedback_resolution.length === 0)
        ) {
          return {
            content: [
              {
                type: "text",
                text: "submit_review requires `prior_feedback_resolution` because prior review comments were provided. Add 1-3 bullets on where earlier feedback is correct/incorrect and why.",
              },
            ],
            details: {
              ok: false,
              reason: "missing prior_feedback_resolution",
            },
          };
        }

        if (!candidate.maintainability_assessment?.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "submit_review requires `maintainability_assessment` as one concise sentence (either concerns found, or explicitly none).",
              },
            ],
            details: {
              ok: false,
              reason: "missing maintainability_assessment",
            },
          };
        }

        // CHANGED: if any KB entry from this PR was returned during the session,
        // require the agent to confirm it checked PR comments for contradictions.
        if (
          kbCurrentPrMatchReturned &&
          (!candidate.confidence_notes ||
            candidate.confidence_notes.length === 0)
        ) {
          return {
            content: [
              {
                type: "text",
                text:
                  "One or more KB entries retrieved during this review were sourced from " +
                  "the current PR and may have been corrected by engineers in the PR conversation. " +
                  "Add `confidence_notes` explaining whether you checked the PR comments for " +
                  "contradictions, then call submit_review again.",
              },
            ],
            details: {
              ok: false,
              reason: "missing confidence_notes after current-PR KB match",
            },
          };
        }

        submittedReview = candidate;
        logger.info(
          `Received structured review via submit_review (${submittedReview.findings.length} finding(s))`,
        );
        return {
          content: [
            {
              type: "text",
              text: "Review received. Do not output the review as normal text.",
            },
          ],
          details: {},
        };
      },
    };

    const queryKnowledgeBaseTool: ToolDefinition = {
      name: "query_knowledge_base",
      label: "Query Knowledge Base",
      description:
        "Search runtime knowledge discovered from prior PR reviews: edge cases, " +
        "observed failure modes, call-chain constraints, and behaviors that diverge " +
        "from documentation. This source is complementary to AGENTS.md — it contains " +
        "only what was found by reading actual code diffs, not what the team documented intentionally.",
      parameters: QUERY_KNOWLEDGE_BASE_SCHEMA,
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        kbQueryCalls++;
        const result = await queryKnowledgeBase(
          knowledgeBaseConfig,
          targetRepo,
          params as {
            query: string;
            paths?: string[];
            symbols?: string[];
            max_results?: number;
          },
        );
        if (!result.ok) {
          return {
            content: [
              {
                type: "text",
                text: `query_knowledge_base unavailable: ${result.reason ?? "unknown error"}`,
              },
            ],
            details: { ok: false, reason: result.reason },
          };
        }

        if (result.matches.length === 0) {
          kbNoMatchResponses++;
          return {
            content: [
              {
                type: "text",
                text: "No prior durable learnings matched this query.",
              },
            ],
            details: { ok: true, matches: [] },
          };
        }

        const summary = result.matches
          .map((match, index) => {
            const lines: string[] = [
              `${index + 1}. [${match.category}] (confidence: ${match.confidence})`,
            ];
            // Show the question this learning was extracted to answer first —
            // helps the agent judge whether the retrieved fact is relevant to
            // its current query before reading the full learning text.
            if (match.answersQuery) {
              lines.push(`   Q: ${match.answersQuery}`);
            }
            lines.push(`   ${match.learning}`);
            // Surface any associated file paths and symbols so the agent can
            // immediately cross-reference them against the current diff scope.
            if (match.paths.length > 0) {
              lines.push(`   paths: ${match.paths.join(", ")}`);
            }
            if (match.symbols.length > 0) {
              lines.push(`   symbols: ${match.symbols.join(", ")}`);
            }

            // CHANGED: Warn when this learning was sourced from the current PR.
            // This means it was extracted during a prior review of this same PR —
            // the PR conversation may have since corrected or contradicted it.
            // The agent should check PR comments before relying on this entry.
            if (match.sourcePrs.includes(prUrl)) {
              lines.push(
                `   ⚠ This learning was extracted from the current PR. ` +
                  `Check the PR conversation for corrections before relying on it.`,
              );
            }
            return lines.join("\n");
          })
          .join("\n\n");
        const fallbackNote = result.pathSymbolFallback
          ? `Note: no matches found for the specified paths/symbols; showing top results by semantic similarity instead.\n\n`
          : "";

        if (result.matches.some((m) => m.sourcePrs.includes(prUrl))) {
          kbCurrentPrMatchReturned = true;
        }

        return {
          content: [
            {
              type: "text",
              text: `${fallbackNote}Matched prior learnings:\n\n${summary}`,
            },
          ],
          details: { ok: true, matches: result.matches },
        };
      },
    };

    const { session } = await createAgentSession({
      cwd: workspacePath,
      model: piModel,
      thinkingLevel,
      tools: [
        createReadTool(workspacePath),
        createBashTool(
          workspacePath,
          rtkAvailable ? { spawnHook: createRtkSpawnHook() } : undefined,
        ),
        createGrepTool(workspacePath),
        createFindTool(workspacePath),
        createLsTool(workspacePath),
      ],
      customTools: [queryKnowledgeBaseTool, submitReviewTool],
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
    });

    // Subscribe to agent events for progress + metrics tracking
    let turnCount = 0;
    let toolCallCount = 0;

    /** Extract human-readable summary from tool args */
    function formatToolArgs(_toolName: string, args: unknown): string {
      if (typeof args === "string") return args.slice(0, 200);
      const obj = args as Record<string, unknown> | undefined;
      if (!obj) return "";
      // bash tool: show the command, strip workspace prefix
      if (obj.command) {
        return String(obj.command)
          .replace(
            new RegExp(
              `cd ${workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} && `,
            ),
            "",
          )
          .slice(0, 200);
      }
      // grep/find: show pattern + path
      if (obj.pattern) {
        const path = obj.path ? ` in ${obj.path}` : "";
        return `${obj.pattern}${path}`;
      }
      // read/ls: show the path
      if (obj.path || obj.file_path) return String(obj.path ?? obj.file_path);
      return JSON.stringify(obj).slice(0, 200);
    }

    /** Extract text content from tool result */
    function formatToolResult(result: unknown): string {
      if (typeof result === "string") return result;
      const obj = result as Record<string, unknown> | undefined;
      if (!obj) return "";
      // pi-sdk wraps results as {content: [{type: "text", text: "..."}]}
      const content = obj.content as
        | Array<{ type?: string; text?: string }>
        | undefined;
      if (Array.isArray(content)) {
        return content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
      }
      return JSON.stringify(result)?.slice(0, 500) ?? "";
    }

    session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          onEvent?.({ type: "agent_start" });
          break;
        case "agent_end":
          onEvent?.({ type: "agent_end" });
          break;
        case "turn_start":
          turnCount++;
          onEvent?.({ type: "turn_start", turnIndex: turnCount });
          break;
        case "turn_end":
          onEvent?.({ type: "turn_end", turnIndex: turnCount });
          break;
        case "tool_execution_start":
          toolCallCount++;
          onEvent?.({
            type: "tool_start",
            toolName: event.toolName,
            toolArgs: formatToolArgs(event.toolName, event.args),
          });
          break;
        case "tool_execution_end":
          onEvent?.({
            type: "tool_end",
            toolName: event.toolName,
            isError: event.isError,
            result: formatToolResult(event.result),
          });
          break;
        case "message_start":
          onEvent?.({ type: "thinking" });
          break;
        case "message_update": {
          const msgEvent = (event as Record<string, unknown>)
            .assistantMessageEvent as
            | { type: string; delta?: string }
            | undefined;
          if (!msgEvent?.delta) break;
          if (msgEvent.type === "text_delta") {
            onEvent?.({ type: "text_delta", delta: msgEvent.delta });
          } else if (msgEvent.type === "thinking_delta") {
            onEvent?.({ type: "thinking_delta", delta: msgEvent.delta });
          }
          break;
        }
      }
    });

    logger.info("Sending prompt to agent...");
    await session.prompt(prompt);

    // Check for agent errors (pi-ai swallows LLM errors into state.error)
    const agentError = (session as unknown as { state: { error?: string } })
      .state?.error;
    if (agentError) {
      throw new Error(`LLM request failed: ${agentError}`);
    }

    if (!submittedReview) {
      const rawText = session.getLastAssistantText() ?? "";
      if (rawText) {
        logger.debug(
          `Last assistant text without submit_review (first 500 chars): ${rawText.slice(0, 500)}`,
        );
      } else {
        const messages = (
          session as unknown as { state: { messages: unknown[] } }
        ).state?.messages;
        const lastMsg = messages?.[messages.length - 1];
        logger.debug(`Last message: ${JSON.stringify(lastMsg)?.slice(0, 500)}`);
      }
      if (submitReviewCalls > 0) {
        throw new Error(
          "Agent called submit_review but did not provide a valid review payload",
        );
      }
      throw new Error("Agent did not call submit_review");
    }

    const review = submittedReview as ReviewOutput;
    if (submitReviewCalls > 1) {
      logger.warn(
        `Agent called submit_review ${submitReviewCalls} times; using the first valid submission`,
      );
    }
    logger.info(
      `Captured ${review.findings.length} finding(s), verdict: ${review.overall_correctness}`,
    );

    const durationSeconds = (Date.now() - startTime) / 1000;
    logger.info(`Review complete (${review.findings.length} finding(s))`);

    // Aggregate usage from all assistant messages
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

    const allMessages =
      (session as unknown as { state: { messages: AssistantMsg[] } }).state
        ?.messages ?? [];

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let cost = 0;

    for (const msg of allMessages) {
      if (msg.role === "assistant" && msg.usage) {
        inputTokens += msg.usage.input ?? 0;
        outputTokens += msg.usage.output ?? 0;
        cacheReadTokens += msg.usage.cacheRead ?? 0;
        cacheWriteTokens += msg.usage.cacheWrite ?? 0;
        totalTokens += msg.usage.totalTokens ?? 0;
        cost += msg.usage.cost?.total ?? 0;
      }
    }

    const metrics: ReviewMetrics = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      cost,
      turns: turnCount,
      toolCalls: toolCallCount,
      durationSeconds: Math.round(durationSeconds),
    };
    printMetrics(metrics);

    let knowledgeExtraction:
      | {
          attempted: true;
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
      | { attempted: false; skippedReason: string }
      | null = null;

    // Post-review knowledge extraction pass (non-blocking)
    if (knowledgeBaseConfig.enabled && knowledgeBaseConfig.writeEnabled) {
      try {
        const transcriptMessages =
          (
            session as unknown as {
              state: { messages: Array<{ role: string; content?: unknown }> };
            }
          ).state?.messages ?? [];
        const reviewOutputJson = JSON.stringify(review, null, 2);
        const extractionResult = await runKnowledgeExtraction({
          config: knowledgeBaseConfig,
          targetRepo,
          prUrl,
          reviewModel: model,
          reviewPiModel: piModel,
          transcript: transcriptMessages,
          reviewOutput: reviewOutputJson,
        });
        knowledgeExtraction = { attempted: true, ...extractionResult };
        if (extractionResult.saved > 0 || extractionResult.updated > 0) {
          logger.info(
            `Knowledge extraction: ${extractionResult.saved} new, ${extractionResult.updated} merged, ${extractionResult.rejected} rejected`,
          );
        }
        if (extractionResult.errors.length > 0) {
          logger.warn(
            `Knowledge extraction errors: ${extractionResult.errors.join("; ")}`,
          );
        }
      } catch (err) {
        knowledgeExtraction = {
          attempted: true,
          extracted: 0,
          saved: 0,
          updated: 0,
          rejected: 0,
          learnings: [],
          errors: [err instanceof Error ? err.message : String(err)],
        };
        logger.warn(
          `Knowledge extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (!knowledgeBaseConfig.enabled) {
      knowledgeExtraction = { attempted: false, skippedReason: "disabled" };
    } else if (!knowledgeBaseConfig.writeEnabled) {
      knowledgeExtraction = {
        attempted: false,
        skippedReason: "writes disabled",
      };
    }

    let metricsFooter: string | null = null;
    if (includeMetricsFooter) {
      const lines = [formatMetricsMarkdown(metrics)];
      if (knowledgeExtraction) {
        lines.push(formatKnowledgeExtractionMarkdown(knowledgeExtraction));
      }
      metricsFooter = lines.join("\n");
    }

    const repoUrl = `https://${host}/${owner}/${repo}`;
    const renderContext: RenderContext = {
      platform,
      repoUrl,
      sourceRef: mrMetadata?.source_branch,
    };

    return { review, metricsFooter, renderContext };
  } finally {
    // Restore mutated env vars
    for (const [key, val] of Object.entries(envSnapshot)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }

    if (cleanup && isTemporary) {
      logger.info("Cleaning up workspace...");
      await cleanupWorkspace(workspacePath);
    }
  }
}
