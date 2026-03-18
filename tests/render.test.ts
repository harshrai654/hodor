import { describe, test, expect } from "vitest";
import { renderMarkdown } from "../src/render.js";
import type { ReviewOutput } from "../src/types.js";

describe("renderMarkdown", () => {
  test("renders empty findings", () => {
    const review: ReviewOutput = {
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No issues found in the changes.",
    };
    const md = renderMarkdown(review);
    expect(md).toContain("### Issues Found");
    expect(md).toContain("No issues found.");
    expect(md).toContain("### Summary");
    expect(md).toContain("Total issues: 0 critical, 0 important, 0 minor.");
    expect(md).toContain("**Status**: Patch is correct");
  });

  test("renders findings grouped by priority", () => {
    const review: ReviewOutput = {
      findings: [
        {
          title: "[P0] SQL injection in login",
          body: "User input concatenated into query.",
          priority: 0,
          code_location: {
            absolute_file_path: "/builds/acme/app/src/db.ts",
            line_range: { start: 12, end: 15 },
          },
        },
        {
          title: "[P2] Missing index on user_id",
          body: "Full table scan on every request.",
          priority: 2,
          code_location: {
            absolute_file_path: "/builds/acme/app/src/models.ts",
            line_range: { start: 89, end: 89 },
          },
        },
        {
          title: "[P3] Magic number 42",
          body: "Should be a named constant.",
          priority: 3,
          code_location: {
            absolute_file_path: "/builds/acme/app/src/util.ts",
            line_range: { start: 7, end: 7 },
          },
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "SQL injection is a blocker.",
    };
    const md = renderMarkdown(review);
    expect(md).toContain("**Critical (P0/P1)**");
    expect(md).toContain("**Important (P2)**");
    expect(md).toContain("**Minor (P3)**");
    expect(md).toContain("Total issues: 1 critical, 1 important, 1 minor.");
    expect(md).toContain("**Status**: Patch has blocking issues");
    // Check path stripping: /builds/acme/app/src/db.ts → src/db.ts
    expect(md).toContain("`src/db.ts:12-15`");
    expect(md).toContain("`src/models.ts:89`");
  });

  test("renders optional sections and location links when context exists", () => {
    const review: ReviewOutput = {
      findings: [
        {
          title: "[P1] Null check missing",
          body: "This path can dereference undefined.",
          priority: 1,
          code_location: {
            absolute_file_path: "/home/runner/work/backend/backend/server/api/service.js",
            line_range: { start: 53, end: 58 },
          },
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "A production crash path remains.",
      pr_understanding: ["Adds new cohort matching functions and resolver paths."],
      change_summary: ["Introduces global cohort calculations based on gains/losses."],
      analysis_scope: ["Reviewed all changed service/factory files and tests."],
      kb_question_closure:
        "No KB matches existed; resolved by tracing factory-to-service usage in current diff.",
    };

    const md = renderMarkdown(review, {
      platform: "github",
      repoUrl: "https://github.com/acme/backend",
      sourceRef: "feature/new-cohorts",
    });
    expect(md).toContain("### PR Understanding");
    expect(md).toContain("### Change Summary");
    expect(md).toContain("### Scope & Assumptions");
    expect(md).toContain("### Knowledge Closure");
    expect(md).toContain(
      "[server/api/service.js:53-58](https://github.com/acme/backend/blob/feature%2Fnew-cohorts/server/api/service.js#L53-L58)",
    );
  });
});
