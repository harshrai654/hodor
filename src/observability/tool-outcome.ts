const TARGET_LIMIT = 200;
const REASON_LIMIT = 120;

type AttributeValue = string | number | boolean;

export interface KbQuerySignal {
  query: string;
  result: "match" | "no_match" | "error";
  matchCount: number;
  closureRequired: boolean;
  topScore?: number;
  pathSymbolFallback?: boolean;
}

export function kbQueryAttributes(
  signal: KbQuerySignal,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    "hodor.kb.query": signal.query.slice(0, TARGET_LIMIT),
    "hodor.kb.result": signal.result,
    "hodor.kb.match_count": signal.matchCount,
    "hodor.kb.closure_required": signal.closureRequired,
  };
  if (typeof signal.topScore === "number") {
    attributes["hodor.kb.top_score"] = signal.topScore;
  }
  if (signal.pathSymbolFallback) {
    attributes["hodor.kb.path_symbol_fallback"] = true;
  }
  return attributes;
}

export function toolTargetAttributes(
  toolName: string,
  args: unknown,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  const record = asRecord(args);
  const target = targetFromArgs(toolName, record);
  if (target) attributes["hodor.tool.target"] = target.slice(0, TARGET_LIMIT);
  const path = stringField(record, "path") ?? stringField(record, "file_path");
  if (path && toolName !== "read" && toolName !== "ls") {
    attributes["hodor.tool.path"] = path.slice(0, TARGET_LIMIT);
  }
  return attributes;
}

export function toolOutcomeAttributes(opts: {
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
}): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    ...toolTargetAttributes(opts.toolName, opts.args),
  };
  const text = resultText(opts.result);
  if (text) attributes["hodor.tool.output_chars"] = text.length;

  if (opts.toolName === "query_knowledge_base") {
    const kb = kbOutcome(opts.args, opts.result, opts.isError);
    const result = kb["hodor.kb.result"];
    return {
      ...attributes,
      ...kb,
      ...(typeof result === "string"
        ? { "hodor.tool.outcome": result === "match" ? "ok" : result }
        : {}),
    };
  }
  if (opts.toolName === "submit_review") {
    return { ...attributes, ...submitOutcome(opts.result, opts.isError) };
  }
  if (opts.toolName === "bash") {
    return { ...attributes, ...bashOutcome(text, opts.isError) };
  }
  if (opts.toolName === "grep") {
    return { ...attributes, ...grepOutcome(text, opts.isError) };
  }

  const lines = nonEmptyLines(text);
  attributes["hodor.tool.result_count"] = lines;
  attributes["hodor.tool.outcome"] = opts.isError
    ? "error"
    : lines === 0 && text !== undefined
      ? "empty"
      : "ok";
  return attributes;
}

function kbOutcome(
  args: unknown,
  result: unknown,
  isError: boolean | undefined,
): Record<string, AttributeValue> {
  const query = stringField(asRecord(args), "query") ?? "";
  const details = resultDetails(result);
  const matches = Array.isArray(details?.matches) ? details.matches : undefined;
  const fallback = details?.pathSymbolFallback === true;
  if (details?.ok === false || isError) {
    return kbQueryAttributes({
      query,
      result: "error",
      matchCount: 0,
      closureRequired: false,
    });
  }
  if (matches && matches.length === 0) {
    return kbQueryAttributes({
      query,
      result: "no_match",
      matchCount: 0,
      closureRequired: true,
      pathSymbolFallback: fallback,
    });
  }
  if (!matches) {
    return { "hodor.tool.outcome": "ok" };
  }
  const scores = matches
    .map((match) => asRecord(match)?.confidence)
    .filter((score): score is number => typeof score === "number");
  return kbQueryAttributes({
    query,
    result: "match",
    matchCount: matches.length,
    closureRequired: false,
    topScore: scores.length > 0 ? Math.max(...scores) : undefined,
    pathSymbolFallback: fallback,
  });
}

function submitOutcome(
  result: unknown,
  isError: boolean | undefined,
): Record<string, AttributeValue> {
  const details = resultDetails(result);
  if (details?.ok === false || isError) {
    const reason = stringField(details, "reason");
    return {
      "hodor.tool.outcome": "rejected",
      ...(reason ? { "hodor.tool.reason": reason.slice(0, REASON_LIMIT) } : {}),
    };
  }
  return { "hodor.tool.outcome": "accepted" };
}

function bashOutcome(
  text: string | undefined,
  isError: boolean | undefined,
): Record<string, AttributeValue> {
  const exit = text?.match(/exited with code (\d+)/);
  if (isError) {
    return {
      "hodor.tool.outcome": "error",
      ...(exit ? { "hodor.tool.exit_code": Number(exit[1]) } : {}),
    };
  }
  return { "hodor.tool.outcome": "ok", "hodor.tool.exit_code": 0 };
}

function grepOutcome(
  text: string | undefined,
  isError: boolean | undefined,
): Record<string, AttributeValue> {
  if (isError) return { "hodor.tool.outcome": "error", "hodor.tool.result_count": 0 };
  if (!text || text.trim() === "No matches found") {
    return { "hodor.tool.outcome": "empty", "hodor.tool.result_count": 0 };
  }
  return {
    "hodor.tool.outcome": "ok",
    "hodor.tool.result_count": nonEmptyLines(text),
  };
}

function targetFromArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (toolName === "bash") return stringField(args, "command");
  if (toolName === "grep" || toolName === "find") {
    return stringField(args, "pattern");
  }
  if (toolName === "query_knowledge_base") return stringField(args, "query");
  return stringField(args, "path") ?? stringField(args, "file_path");
}

function resultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const content = asRecord(result)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => stringField(asRecord(item), "text"))
    .filter((item): item is string => !!item)
    .join("\n");
  return text;
}

function resultDetails(
  result: unknown,
): Record<string, unknown> | undefined {
  return asRecord(asRecord(result)?.details);
}

function nonEmptyLines(text: string | undefined): number {
  if (!text) return 0;
  return text.split("\n").filter((line) => line.trim()).length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
