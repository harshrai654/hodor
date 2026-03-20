import { describe, expect, it } from "vitest";

import { mapReviewEventToCheckStage } from "../src/review-check-stages.js";

describe("mapReviewEventToCheckStage", () => {
  it("maps agent_start", () => {
    const update = mapReviewEventToCheckStage({ type: "agent_start" });
    expect(update).toEqual({
      stage: "Analyzing PR",
      summary: "Analyzing PR",
    });
  });

  it("maps turn_start", () => {
    const update = mapReviewEventToCheckStage({
      type: "turn_start",
      turnIndex: 3,
    });
    expect(update).toEqual({
      stage: "turn:3",
      summary: "Analysis turn 3",
    });
  });

  it("maps tool_start for known tools (including truncated args)", () => {
    const longArgs = "a".repeat(200);
    const update = mapReviewEventToCheckStage({
      type: "tool_start",
      toolName: "grep",
      toolArgs: longArgs,
    });

    expect(update?.stage).toBe("tool:grep");
    expect(update?.summary.startsWith("Searching: ")).toBe(true);
    expect(update?.summary.endsWith("…")).toBe(true);
  });

  it("returns null for unknown tools", () => {
    const update = mapReviewEventToCheckStage({
      type: "tool_start",
      toolName: "some_unknown_tool",
      toolArgs: "x",
    });
    expect(update).toBeNull();
  });

  it("maps agent_end", () => {
    const update = mapReviewEventToCheckStage({ type: "agent_end" });
    expect(update).toEqual({
      stage: "Extracting review",
      summary: "Extracting review...",
    });
  });
});

