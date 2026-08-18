import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUBMIT_REVIEW_FOLLOWUP_PROMPT,
  SUBMIT_REVIEW_RETRY_PROMPT,
  buildSubmitReviewFollowupPrompt,
  missingSubmitReviewError,
  resolveSubmitReviewMaxRetries,
  runUntilSubmitReview,
  type SubmitReviewSession,
} from "../src/submit-review-guard.js";

function createMockSession(): SubmitReviewSession & {
  prompts: string[];
  activeTools: string[][];
} {
  const prompts: string[] = [];
  const activeTools: string[][] = [];
  return {
    prompts,
    activeTools,
    state: {},
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
    }),
    setActiveToolsByName: vi.fn((toolNames: string[]) => {
      activeTools.push([...toolNames]);
    }),
    getLastAssistantText: vi.fn(() => undefined),
  };
}

describe("resolveSubmitReviewMaxRetries", () => {
  afterEach(() => {
    delete process.env.HODOR_SUBMIT_REVIEW_MAX_RETRIES;
  });

  it("defaults to 2", () => {
    expect(resolveSubmitReviewMaxRetries()).toBe(2);
  });

  it("reads env override", () => {
    process.env.HODOR_SUBMIT_REVIEW_MAX_RETRIES = "5";
    expect(resolveSubmitReviewMaxRetries()).toBe(5);
  });

  it("falls back for invalid env", () => {
    process.env.HODOR_SUBMIT_REVIEW_MAX_RETRIES = "nope";
    expect(resolveSubmitReviewMaxRetries()).toBe(2);
  });
});

describe("buildSubmitReviewFollowupPrompt", () => {
  it("asks for first submission when no prior calls", () => {
    expect(buildSubmitReviewFollowupPrompt(0)).toBe(SUBMIT_REVIEW_FOLLOWUP_PROMPT);
  });

  it("asks to fix payload when prior calls failed validation", () => {
    expect(buildSubmitReviewFollowupPrompt(1)).toBe(SUBMIT_REVIEW_RETRY_PROMPT);
  });
});

describe("missingSubmitReviewError", () => {
  it("distinguishes missing tool call from invalid payload", () => {
    expect(missingSubmitReviewError(0).message).toBe(
      "Agent did not call submit_review",
    );
    expect(missingSubmitReviewError(2).message).toBe(
      "Agent called submit_review but did not provide a valid review payload",
    );
  });
});

describe("runUntilSubmitReview", () => {
  it("does not retry when submit_review succeeds on first prompt", async () => {
    const session = createMockSession();

    await runUntilSubmitReview({
      session,
      initialPrompt: "review this PR",
      isSubmitted: () => true,
      getSubmitReviewCalls: () => 0,
      maxRetries: 2,
    });

    expect(session.prompts).toEqual(["review this PR"]);
    expect(session.activeTools).toEqual([]);
  });

  it("retries with submit_review-only tools until submission succeeds", async () => {
    const session = createMockSession();
    let submitted = false;
    let promptCount = 0;

    session.prompt = vi.fn(async (text: string) => {
      promptCount++;
      session.prompts.push(text);
      if (promptCount >= 2) {
        submitted = true;
      }
    });

    await runUntilSubmitReview({
      session,
      initialPrompt: "review this PR",
      isSubmitted: () => submitted,
      getSubmitReviewCalls: () => 0,
      maxRetries: 2,
    });

    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toBe(SUBMIT_REVIEW_FOLLOWUP_PROMPT);
    expect(session.activeTools).toEqual([["submit_review"]]);
  });

  it("throws when session reports an LLM error", async () => {
    const session = createMockSession();
    session.state.error = "rate limited";

    await expect(
      runUntilSubmitReview({
        session,
        initialPrompt: "review this PR",
        isSubmitted: () => false,
        getSubmitReviewCalls: () => 0,
        maxRetries: 0,
      }),
    ).rejects.toThrow("LLM request failed: rate limited");
  });
});
