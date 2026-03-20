import type { AgentProgressEvent } from "./agent.js";

export interface ReviewCheckStageUpdate {
  stage: string;
  summary: string;
}

const TOOL_STAGE_LABELS: Record<string, string> = {
  query_knowledge_base: "Querying knowledge base",
  save_knowledge_base: "Saving to knowledge base",
  read: "Reading files",
  grep: "Searching",
  find: "Finding",
  ls: "Listing",
  bash: "Running commands",
};

function truncateForSummary(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

export function mapReviewEventToCheckStage(
  event: AgentProgressEvent,
): ReviewCheckStageUpdate | null {
  switch (event.type) {
    case "agent_start":
      return { stage: "Analyzing PR", summary: "Analyzing PR" };
    case "turn_start":
      return {
        stage: `turn:${event.turnIndex ?? "?"}`,
        summary: `Analysis turn ${event.turnIndex ?? "?"}`,
      };
    case "tool_start": {
      const toolName = event.toolName;
      if (!toolName) return null;
      const label = TOOL_STAGE_LABELS[toolName];
      if (!label) return null;

      const args = event.toolArgs
        ? `: ${truncateForSummary(event.toolArgs, 120)}`
        : "";
      return {
        stage: `tool:${toolName}`,
        summary: `${label}${args}`,
      };
    }
    case "agent_end":
      return { stage: "Extracting review", summary: "Extracting review..." };
    default:
      return null;
  }
}

