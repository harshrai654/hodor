import { describe, expect, test } from "vitest";
import { validateReviewOutput } from "../src/review.js";
import type { ReviewOutput } from "../src/types.js";

function makeReview(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    findings: [
      {
        title: "[P1] Missing null guard",
        body: "This crashes when the API returns a null payload.",
        priority: 1,
        code_location: {
          absolute_file_path: "/workspace/src/api.ts",
          line_range: { start: 12, end: 14 },
        },
      },
    ],
    overall_correctness: "patch is incorrect",
    overall_explanation: "The change introduces a crash on a valid error path.",
    ...overrides,
  };
}

describe("validateReviewOutput", () => {
  test("accepts a valid structured review", () => {
    const review = makeReview();
    expect(validateReviewOutput(review)).toEqual(review);
  });

  test("accepts optional context sections", () => {
    const review = makeReview({
      pr_understanding: ["Adds integration cohort evaluation flow for recalculation."],
      change_summary: ["Introduces new cohort matching factory and constants."],
      analysis_scope: ["Reviewed service and factory diffs plus tests."],
      confidence_notes: ["No unresolved edge-case assumptions remain."],
      kb_question_closure: "No prior KB matches; behavior was resolved by validating service call flow and tests in this PR diff.",
    });
    expect(validateReviewOutput(review)).toEqual(review);
  });

  test("rejects mismatched title and numeric priority", () => {
    const review = makeReview({
      findings: [
        {
          title: "[P2] Missing null guard",
          body: "This crashes when the API returns a null payload.",
          priority: 1,
          code_location: {
            absolute_file_path: "/workspace/src/api.ts",
            line_range: { start: 12, end: 14 },
          },
        },
      ],
    });

    expect(() => validateReviewOutput(review)).toThrow(
      "submit_review finding 1 priority 1 does not match title tag 2",
    );
  });

  test("rejects relative file paths", () => {
    const review = makeReview({
      findings: [
        {
          title: "[P1] Missing null guard",
          body: "This crashes when the API returns a null payload.",
          priority: 1,
          code_location: {
            absolute_file_path: "src/api.ts",
            line_range: { start: 12, end: 14 },
          },
        },
      ],
    });

    expect(() => validateReviewOutput(review)).toThrow(
      "submit_review finding 1 code_location.absolute_file_path must be absolute",
    );
  });

  test("rejects inverted line ranges", () => {
    const review = makeReview({
      findings: [
        {
          title: "[P1] Missing null guard",
          body: "This crashes when the API returns a null payload.",
          priority: 1,
          code_location: {
            absolute_file_path: "/workspace/src/api.ts",
            line_range: { start: 14, end: 12 },
          },
        },
      ],
    });

    expect(() => validateReviewOutput(review)).toThrow(
      "submit_review finding 1 code_location line_range start must be <= end",
    );
  });

  test("rejects empty kb_question_closure when provided", () => {
    const review = makeReview({
      kb_question_closure: "   ",
    });
    expect(() => validateReviewOutput(review)).toThrow(
      "submit_review kb_question_closure must be non-empty when provided",
    );
  });
});
