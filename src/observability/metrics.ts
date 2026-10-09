import { Counter, Histogram, Registry } from "prom-client";

export const registry = new Registry();

export type CommandName = "review" | "learn";
export type RunOutcome = "success" | "failure";
export type TokenPhase = "review" | "extract" | "learn";
export type KnowledgeSource = "review" | "learn";
export type KnowledgeStage = "extracted" | "saved" | "updated" | "rejected";
export type KbQueryResult = "match" | "no_match" | "error";

const runsTotal = new Counter({
  name: "hodor_runs_total",
  help: "Hodor commands that finished, including failures",
  labelNames: ["command", "model", "repo", "outcome"] as const,
  registers: [registry],
});

const tokensTotal = new Counter({
  name: "hodor_tokens_total",
  help: "Tokens consumed by Hodor LLM calls",
  labelNames: ["kind", "phase", "model"] as const,
  registers: [registry],
});

const costUsdTotal = new Counter({
  name: "hodor_cost_usd_total",
  help: "Estimated LLM cost in USD",
  labelNames: ["phase", "model"] as const,
  registers: [registry],
});

const filesTouched = new Histogram({
  name: "hodor_files_touched",
  help: "Distinct files a review touched",
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [registry],
});

const reviewsTotal = new Counter({
  name: "hodor_reviews_total",
  help: "Completed reviews by overall correctness",
  labelNames: ["correctness", "model", "repo"] as const,
  registers: [registry],
});

const knowledgePointsTotal = new Counter({
  name: "hodor_knowledge_points_total",
  help: "Knowledge candidates by pipeline stage",
  labelNames: ["source", "stage"] as const,
  registers: [registry],
});

const kbQueriesTotal = new Counter({
  name: "hodor_kb_queries_total",
  help: "Knowledge base queries by result",
  labelNames: ["result"] as const,
  registers: [registry],
});

const toolCallsTotal = new Counter({
  name: "hodor_tool_calls_total",
  help: "Agent tool executions",
  labelNames: ["tool", "command"] as const,
  registers: [registry],
});

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface KnowledgeCounts {
  extracted: number;
  saved: number;
  updated: number;
  rejected: number;
}

export function recordRun(opts: {
  command: CommandName;
  model: string;
  repo: string;
  outcome: RunOutcome;
}): void {
  runsTotal.inc({
    command: opts.command,
    model: label(opts.model),
    repo: label(opts.repo),
    outcome: opts.outcome,
  });
}

export function recordTokenUsage(
  phase: TokenPhase,
  model: string,
  usage: TokenUsage,
): void {
  const modelLabel = label(model);
  incIfPositive(tokensTotal, usage.inputTokens, {
    kind: "input",
    phase,
    model: modelLabel,
  });
  incIfPositive(tokensTotal, usage.outputTokens, {
    kind: "output",
    phase,
    model: modelLabel,
  });
  incIfPositive(tokensTotal, usage.cacheReadTokens, {
    kind: "cache_read",
    phase,
    model: modelLabel,
  });
  incIfPositive(tokensTotal, usage.cacheWriteTokens, {
    kind: "cache_write",
    phase,
    model: modelLabel,
  });
  incIfPositive(costUsdTotal, usage.cost, { phase, model: modelLabel });
}

export function recordFilesTouched(count: number): void {
  filesTouched.observe(count);
}

export function recordReview(opts: {
  correctness: string;
  model: string;
  repo: string;
}): void {
  reviewsTotal.inc({
    correctness: label(opts.correctness),
    model: label(opts.model),
    repo: label(opts.repo),
  });
}

export function recordKnowledgePoints(
  source: KnowledgeSource,
  counts: KnowledgeCounts,
): void {
  const stages: KnowledgeStage[] = [
    "extracted",
    "saved",
    "updated",
    "rejected",
  ];
  for (const stage of stages) {
    incIfPositive(knowledgePointsTotal, counts[stage], { source, stage });
  }
}

export function recordKbQuery(result: KbQueryResult): void {
  kbQueriesTotal.inc({ result });
}

export function recordToolCall(tool: string, command: CommandName): void {
  toolCallsTotal.inc({ tool: label(tool), command });
}

export function resetMetricsForTests(): void {
  registry.resetMetrics();
}

function label(value: string): string {
  const trimmed = value.trim();
  return trimmed || "unknown";
}

function incIfPositive(
  metric: Counter<string>,
  value: number,
  labels: Record<string, string>,
): void {
  if (value > 0) metric.inc(labels, value);
}
