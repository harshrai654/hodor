import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uncompress } from "snappyjs";
import {
  noteTouchedFile,
  pathsFromToolCall,
  resetTouchedFiles,
  touchedFiles,
} from "../src/observability/files.js";
import {
  instrumentAgentSession,
  GEN_AI_PROMPT_ATTRIBUTE_KEYS,
  PiInstrumentation,
  type AgentSessionLike,
  type PiAgentEvent,
} from "../src/observability/instrumentation-pi.js";
import {
  finishThenExit,
  requestExit,
  requestedExitCode,
  resetRequestedExitForTests,
} from "../src/observability/lifecycle.js";
import {
  recordFilesTouched,
  recordKnowledgePoints,
  recordRun,
  resetMetricsForTests,
} from "../src/observability/metrics.js";
import { pushMetrics } from "../src/observability/remote-write.js";
import {
  grpcEndpoint,
  observabilityEnabled,
} from "../src/observability/sdk.js";
import {
  annotateReview,
  startSpan,
  traceKbQuery,
} from "../src/observability/signals.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
  resetMetricsForTests();
  resetTouchedFiles();
  resetRequestedExitForTests();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SDK_DISABLED;
});

function finishedSpans() {
  return exporter.getFinishedSpans();
}

describe("pathsFromToolCall", () => {
  it("collects paths from read, grep, and bash tokens", () => {
    expect(pathsFromToolCall("read", { path: "src/agent.ts" })).toEqual([
      "src/agent.ts",
    ]);
    expect(
      pathsFromToolCall("grep", { pattern: "foo", path: "src/cli.ts" }),
    ).toEqual(["src/cli.ts"]);
    expect(
      pathsFromToolCall("bash", {
        command: "cat src/review.ts && echo ok -n",
      }),
    ).toEqual(["src/review.ts"]);
    expect(pathsFromToolCall("bash", { command: "curl https://example.com" })).toEqual(
      [],
    );
  });

  it("keeps a capped unique list of touched files", () => {
    noteTouchedFile(" b.ts ");
    noteTouchedFile("a.ts");
    noteTouchedFile("a.ts");
    noteTouchedFile(".");
    expect(touchedFiles()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("Pi instrumentation", () => {
  it("opens session, turn, tool, and gen_ai spans without prompt text", async () => {
    const events: Array<(event: PiAgentEvent) => void> = [];
    const session: AgentSessionLike = {
      subscribe(listener) {
        events.push(listener);
      },
    };
    instrumentAgentSession(session, {
      model: "claude-sonnet",
      provider: "anthropic",
      command: "review",
    });

    const emit = (event: PiAgentEvent) => {
      for (const listener of events) listener(event);
    };
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "read",
      args: { path: "src/metrics.ts" },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "read",
      isError: false,
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet",
        content: [{ type: "text", text: "do not export this prompt" }],
        usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 1 },
      },
    });
    emit({ type: "turn_end" });
    emit({ type: "agent_end" });

    const names = finishedSpans().map((span) => span.name);
    expect(names).toEqual([
      "hodor.tool",
      "gen_ai.chat",
      "hodor.agent.turn",
      "hodor.agent.session",
    ]);
    const chat = finishedSpans().find((span) => span.name === "gen_ai.chat");
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(chat?.attributes["gen_ai.usage.output_tokens"]).toBe(4);
    expect(chat?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(3);
    for (const key of GEN_AI_PROMPT_ATTRIBUTE_KEYS) {
      expect(chat?.attributes[key]).toBeUndefined();
    }
    expect(JSON.stringify(chat?.attributes)).not.toContain("do not export");
    expect(touchedFiles()).toEqual(["src/metrics.ts"]);
  });

  it("patches createAgentSession through the instrumentation definition", async () => {
    const instrumentation = new PiInstrumentation();
    const definition = instrumentation.getModuleDefinitions()[0];
    const moduleExports = {
      async createAgentSession() {
        return {
          session: {
            subscribe(listener: (event: PiAgentEvent) => void) {
              listener({ type: "agent_start" });
              listener({ type: "agent_end" });
            },
          },
        };
      },
    };
    definition?.patch?.(moduleExports);
    await moduleExports.createAgentSession();
    expect(finishedSpans().map((span) => span.name)).toContain(
      "hodor.agent.session",
    );
  });
});

describe("review signals", () => {
  it("records confidence notes, files, and kb query results without a similarity score", () => {
    noteTouchedFile("src/cli.ts");
    const span = startSpan("hodor.review", { "hodor.repo": "acme/api" });
    annotateReview({
      span,
      model: "claude-sonnet",
      repo: "acme/api",
      outcome: "success",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.01,
      },
      correctness: "patch is correct",
      confidenceNotes: ["Checked the PR comments"],
      findings: 1,
      closureRequired: true,
    });
    span.end();

    const review = finishedSpans().find((item) => item.name === "hodor.review");
    expect(review?.attributes["hodor.review.confidence_notes"]).toBe(
      "Checked the PR comments",
    );
    expect(review?.attributes["hodor.review.overall_correctness"]).toBe(
      "patch is correct",
    );
    expect(review?.attributes["hodor.files_touched"]).toEqual(["src/cli.ts"]);

    traceKbQuery({
      query: "how does tenant resolution work",
      result: "no_match",
      matchCount: 0,
      closureRequired: true,
    });
    const query = finishedSpans().find((item) => item.name === "hodor.kb.query");
    expect(query?.attributes["hodor.kb.result"]).toBe("no_match");
    expect(query?.attributes["hodor.kb.match_count"]).toBe(0);
    expect(JSON.stringify(query?.attributes)).not.toContain("confidence");
  });

  it("counts learn-stage knowledge points and pushes hodor_runs_total", async () => {
    recordKnowledgePoints("learn", {
      extracted: 2,
      saved: 1,
      updated: 1,
      rejected: 0,
    });
    recordRun({
      command: "learn",
      model: "claude-sonnet",
      repo: "acme/api",
      outcome: "success",
    });
    recordFilesTouched(4);

    const seen: Array<{ url: string; encoding: string | null; body: string }> =
      [];
    await pushMetrics({
      url: "http://alloy.example/api/v1/metrics/write",
      now: 1_700_000_000_000,
      fetchImpl: async (url, init) => {
        const body = init?.body as Uint8Array;
        const raw = uncompress(body);
        seen.push({
          url: String(url),
          encoding: new Headers(init?.headers).get("Content-Encoding"),
          body: Buffer.from(raw).toString("utf8"),
        });
        return new Response(null, { status: 204 });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.encoding).toBe("snappy");
    expect(seen[0]?.url).toContain("/api/v1/metrics/write");
    expect(seen[0]?.body).toContain("hodor_runs_total");
    expect(seen[0]?.body).toContain("hodor_knowledge_points_total");
    expect(seen[0]?.body).not.toContain("similarity");
  });
});

describe("shutdown", () => {
  it("flushes before exit", async () => {
    const order: string[] = [];
    requestExit(1);
    await finishThenExit({
      finish: async () => {
        order.push("finish");
      },
      exit: (code) => {
        order.push(`exit:${code}`);
      },
      code: requestedExitCode(),
    });
    expect(order).toEqual(["finish", "exit:1"]);
  });
});

describe("sdk config", () => {
  it("stays disabled until an endpoint is set", () => {
    expect(observabilityEnabled()).toBe(false);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "http://alloy.ns-7dpt7m5sy72p.svc.cluster.local:4317/v1/traces";
    expect(observabilityEnabled()).toBe(true);
    expect(grpcEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)).toBe(
      "http://alloy.ns-7dpt7m5sy72p.svc.cluster.local:4317",
    );
    process.env.OTEL_SDK_DISABLED = "true";
    expect(observabilityEnabled()).toBe(false);
  });
});
