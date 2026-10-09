import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "./genai.js";
import { touchedFiles } from "./files.js";
import { kbQueryAttributes, type KbQuerySignal } from "./tool-outcome.js";
import { latestOpenTool } from "./tool-spans.js";
import {
  recordFilesTouched,
  recordKbQuery,
  recordKnowledgePoints,
  recordReview,
  recordRun,
  recordTokenUsage,
  type KnowledgeCounts,
  type KnowledgeSource,
  type RunOutcome,
  type TokenPhase,
  type TokenUsage,
} from "./metrics.js";

const tracer = trace.getTracer("hodor");
const NOTE_LIMIT = 500;
const QUERY_LIMIT = 200;

export function startSpan(
  name: string,
  attributes: Record<string, string | number | boolean>,
): Span {
  return tracer.startSpan(name, { attributes });
}

export function traceIdFromSpan(span: Span): string | undefined {
  if (!span.isRecording()) return undefined;
  const traceId = span.spanContext().traceId;
  if (!traceId || /^0+$/.test(traceId)) return undefined;
  return traceId;
}

export async function withActiveSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function parentContext(span: Span) {
  return trace.setSpan(context.active(), span);
}

export function annotateReview(opts: {
  span: Span;
  model: string;
  repo: string;
  outcome: RunOutcome;
  usage?: TokenUsage & { totalTokens?: number };
  turns?: number;
  toolCalls?: number;
  durationSeconds?: number;
  correctness?: string;
  confidenceNotes?: string[];
  findings?: number;
  closureRequired?: boolean;
  knowledge?: KnowledgeCounts;
}): string | undefined {
  const { span } = opts;
  if (opts.usage) {
    setUsageAttributes(span, opts.usage);
    recordTokenUsage("review", opts.model, opts.usage);
  }
  if (opts.turns !== undefined) span.setAttribute("hodor.turns", opts.turns);
  if (opts.toolCalls !== undefined) {
    span.setAttribute("hodor.tool_calls", opts.toolCalls);
  }
  if (opts.durationSeconds !== undefined) {
    span.setAttribute("hodor.duration_seconds", opts.durationSeconds);
  }
  if (opts.correctness) {
    span.setAttribute("hodor.review.overall_correctness", opts.correctness);
    recordReview({
      correctness: opts.correctness,
      model: opts.model,
      repo: opts.repo,
    });
  }
  const notes = (opts.confidenceNotes ?? []).join(" | ").slice(0, NOTE_LIMIT);
  if (notes) span.setAttribute("hodor.review.confidence_notes", notes);
  if (opts.findings !== undefined) {
    span.setAttribute("hodor.review.findings", opts.findings);
  }
  if (opts.closureRequired !== undefined) {
    span.setAttribute("hodor.kb.closure_required", opts.closureRequired);
  }

  const files = touchedFiles();
  span.setAttribute("hodor.files_touched", files);
  recordFilesTouched(files.length);

  if (opts.knowledge) {
    setKnowledgeAttributes(span, opts.knowledge);
  }

  recordRun({
    command: "review",
    model: opts.model,
    repo: opts.repo,
    outcome: opts.outcome,
  });
  if (opts.outcome === "failure") {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  return traceIdFromSpan(span);
}

export function annotateKnowledge(
  span: Span,
  source: KnowledgeSource,
  phase: TokenPhase,
  model: string,
  counts: KnowledgeCounts,
  usage?: TokenUsage,
): void {
  setKnowledgeAttributes(span, counts);
  recordKnowledgePoints(source, counts);
  if (usage) {
    span.setAttribute(GEN_AI_REQUEST_MODEL, model);
    setUsageAttributes(span, usage);
    recordTokenUsage(phase, model, usage);
  }
}

export function traceKbQuery(opts: KbQuerySignal): void {
  const attributes = kbQueryAttributes({
    ...opts,
    query: opts.query.slice(0, QUERY_LIMIT),
  });
  const tool = latestOpenTool("query_knowledge_base");
  if (tool) {
    for (const [name, value] of Object.entries(attributes)) {
      tool.span.setAttribute(name, value);
    }
    tool.span.setAttribute(
      "hodor.tool.outcome",
      opts.result === "match" ? "ok" : opts.result,
    );
  }
  const span = tracer.startSpan(
    "hodor.kb.query",
    { attributes },
    tool?.context,
  );
  if (opts.result === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR });
    tool?.span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
  recordKbQuery(opts.result);
}

export function withParentSpan<T>(
  span: Span,
  fn: () => Promise<T>,
): Promise<T> {
  return context.with(parentContext(span), fn);
}

export function annotateLearnRoot(
  span: Span,
  model: string,
  result: KnowledgeCounts & { llmMetrics?: TokenUsage },
): void {
  setKnowledgeAttributes(span, result);
  span.setAttribute(GEN_AI_REQUEST_MODEL, model);
  if (!result.llmMetrics) return;
  setUsageAttributes(span, result.llmMetrics);
}

function setUsageAttributes(span: Span, usage: TokenUsage): void {
  span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
  span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
  span.setAttribute(
    GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
    usage.cacheReadTokens,
  );
  span.setAttribute(
    GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
    usage.cacheWriteTokens,
  );
  span.setAttribute("hodor.usage.cost_usd", usage.cost);
}

function setKnowledgeAttributes(span: Span, counts: KnowledgeCounts): void {
  span.setAttribute("hodor.knowledge.extracted", counts.extracted);
  span.setAttribute("hodor.knowledge.saved", counts.saved);
  span.setAttribute("hodor.knowledge.updated", counts.updated);
  span.setAttribute("hodor.knowledge.rejected", counts.rejected);
}
