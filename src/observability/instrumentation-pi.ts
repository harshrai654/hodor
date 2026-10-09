import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from "@opentelemetry/semantic-conventions/incubating";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "./genai.js";
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import { noteTouchedFile, pathsFromToolCall } from "./files.js";
import { recordToolCall, type CommandName } from "./metrics.js";

const tracer = trace.getTracer("hodor");
const INSTRUMENTED = Symbol.for("hodor.pi.instrumented");

export const GEN_AI_PROMPT_ATTRIBUTE_KEYS = [
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
] as const;

export interface AgentSessionLike {
  subscribe: (listener: (event: PiAgentEvent) => void) => void;
}

export interface SessionMeta {
  model?: string;
  provider?: string;
  command?: CommandName;
}

export type PiAgentEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    responseModel?: string;
    content?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
  };
};

type CreateAgentSession = (
  opts: { model?: { id?: string; provider?: string } },
) => Promise<{ session?: AgentSessionLike }>;

export function providerName(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  if (provider === "anthropic") return GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC;
  if (provider === "openai") return GEN_AI_PROVIDER_NAME_VALUE_OPENAI;
  if (provider === "amazon-bedrock") return GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK;
  return provider;
}

export function instrumentAgentSession(
  session: AgentSessionLike,
  meta: SessionMeta = {},
): void {
  const tagged = session as AgentSessionLike & { [INSTRUMENTED]?: boolean };
  if (tagged[INSTRUMENTED]) return;
  tagged[INSTRUMENTED] = true;
  if (typeof session.subscribe !== "function") return;

  const parent = context.active();
  const command = meta.command ?? "review";
  let sessionSpan: Span | undefined;
  let sessionCtx = parent;
  let turnSpan: Span | undefined;
  let turnCtx = parent;
  const toolSpans = new Map<string, Span>();

  session.subscribe((event) => {
    switch (event.type) {
      case "agent_start": {
        sessionSpan = tracer.startSpan(
          "hodor.agent.session",
          { attributes: genAiModelAttributes(meta) },
          parent,
        );
        sessionCtx = trace.setSpan(parent, sessionSpan);
        turnCtx = sessionCtx;
        break;
      }
      case "agent_end": {
        endSpan(turnSpan);
        turnSpan = undefined;
        for (const span of toolSpans.values()) endSpan(span);
        toolSpans.clear();
        endSpan(sessionSpan);
        sessionSpan = undefined;
        break;
      }
      case "turn_start": {
        turnSpan = tracer.startSpan("hodor.agent.turn", {}, sessionCtx);
        turnCtx = trace.setSpan(sessionCtx, turnSpan);
        break;
      }
      case "turn_end": {
        endSpan(turnSpan);
        turnSpan = undefined;
        turnCtx = sessionCtx;
        break;
      }
      case "tool_execution_start": {
        const toolName = event.toolName || "unknown";
        const span = tracer.startSpan(
          "hodor.tool",
          { attributes: { "hodor.tool.name": toolName } },
          turnCtx,
        );
        toolSpans.set(event.toolCallId || toolName, span);
        recordToolCall(toolName, command);
        for (const path of pathsFromToolCall(toolName, event.args)) {
          noteTouchedFile(path);
        }
        break;
      }
      case "tool_execution_end": {
        const key = event.toolCallId || event.toolName || "unknown";
        const span = toolSpans.get(key);
        if (!span) break;
        if (event.isError) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        endSpan(span);
        toolSpans.delete(key);
        break;
      }
      case "message_end": {
        recordGenAiSpan(event, meta, turnCtx);
        break;
      }
      default:
        break;
    }
  });
}

export function wrapCreateAgentSession(
  original: CreateAgentSession,
): CreateAgentSession {
  return async function patchedCreateAgentSession(opts) {
    const result = await original(opts);
    if (result?.session) {
      instrumentAgentSession(result.session, {
        model: opts?.model?.id,
        provider: opts?.model?.provider,
      });
    }
    return result;
  };
}

export class PiInstrumentation extends InstrumentationBase {
  constructor() {
    super("hodor-instrumentation-pi", "0.1.0", {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      "@earendil-works/pi-coding-agent",
      [">=0.80.0"],
      (moduleExports: Record<string, unknown>) => {
        patchPiExports(moduleExports, (target) => {
          this._wrap(target, "createAgentSession", (original) =>
            wrapCreateAgentSession(original as CreateAgentSession),
          );
        });
        return moduleExports;
      },
      (moduleExports: Record<string, unknown>) => {
        patchPiExports(moduleExports, (target) => {
          this._unwrap(target, "createAgentSession");
        });
      },
    );
  }
}

function patchPiExports(
  moduleExports: Record<string, unknown>,
  apply: (target: { createAgentSession: CreateAgentSession }) => void,
): void {
  const candidates = [moduleExports, moduleExports.default].filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object",
  );
  for (const candidate of candidates) {
    if (typeof candidate.createAgentSession === "function") {
      apply(candidate as { createAgentSession: CreateAgentSession });
    }
  }
}

function recordGenAiSpan(
  event: PiAgentEvent,
  meta: SessionMeta,
  parent: ReturnType<typeof context.active>,
): void {
  const message = event.message;
  if (!message || message.role !== "assistant" || !message.usage) return;

  const provider = providerName(message.provider || meta.provider);
  const model = message.model || meta.model;
  const attributes: Record<string, string | number> = {
    [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
  };
  if (provider) attributes[GEN_AI_PROVIDER_NAME] = provider;
  if (model) attributes[GEN_AI_REQUEST_MODEL] = model;
  if (message.responseModel) {
    attributes[GEN_AI_RESPONSE_MODEL] = message.responseModel;
  }
  setNumber(attributes, GEN_AI_USAGE_INPUT_TOKENS, message.usage.input);
  setNumber(attributes, GEN_AI_USAGE_OUTPUT_TOKENS, message.usage.output);
  setNumber(
    attributes,
    GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
    message.usage.cacheRead,
  );
  setNumber(
    attributes,
    GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
    message.usage.cacheWrite,
  );

  const span = tracer.startSpan("gen_ai.chat", { attributes }, parent);
  span.end();
}

function genAiModelAttributes(meta: SessionMeta): Record<string, string> {
  const attributes: Record<string, string> = {};
  const provider = providerName(meta.provider);
  if (provider) attributes[GEN_AI_PROVIDER_NAME] = provider;
  if (meta.model) attributes[GEN_AI_REQUEST_MODEL] = meta.model;
  return attributes;
}

function setNumber(
  attributes: Record<string, string | number>,
  key: string,
  value: number | undefined,
): void {
  if (typeof value === "number") attributes[key] = value;
}

function endSpan(span: Span | undefined): void {
  span?.end();
}
