import { describe, it, expect } from "vitest";
import {
  buildMrSections,
  buildPrReviewPrompt,
  normalizeLabelNames,
} from "../src/prompt.js";

describe("buildMrSections", () => {
  it("handles string labels", () => {
    const metadata = {
      title: "Add string labels support",
      labels: ["bug", "gitlab"],
    };

    const { contextSection } = buildMrSections(metadata);
    expect(contextSection).toContain("- Labels: bug, gitlab");
  });

  it("prefers label_details when available", () => {
    const metadata = {
      title: "Prefer detailed labels",
      labels: ["fallback"],
      label_details: [{ name: "frontend" }, { name: "regression" }],
    };

    const { contextSection } = buildMrSections(metadata);
    expect(contextSection).toContain("- Labels: frontend, regression");
  });

  it("returns empty strings when no metadata", () => {
    const { contextSection, notesSection, reminderSection } =
      buildMrSections(null);
    expect(contextSection).toBe("");
    expect(notesSection).toBe("");
    expect(reminderSection).toBe("");
  });

  it("includes author and branches", () => {
    const metadata = {
      title: "Test PR",
      author: { username: "testuser" },
      source_branch: "feature",
      target_branch: "main",
    };

    const { contextSection } = buildMrSections(metadata);
    expect(contextSection).toContain("- Author: @testuser");
    expect(contextSection).toContain("- Branches: feature → main");
  });

  it("renders prior GitHub review context anonymously", () => {
    const metadata = {
      reviewerSummaries: [
        {
          state: "REQUEST_CHANGES",
          body: "This check can fail when payload is null.",
          author: { username: "alice" },
          submitted_at: "2026-03-18T10:00:00Z",
        },
      ],
      inlineReviewComments: [
        {
          path: "src/review.ts",
          line: 42,
          side: "RIGHT",
          body: "This should guard missing value before dereference.",
          author: { username: "bob" },
          created_at: "2026-03-18T10:05:00Z",
        },
      ],
    };

    const { priorReviewSection } = buildMrSections(metadata);
    expect(priorReviewSection).toContain("## Prior Review Feedback (GitHub)");
    expect(priorReviewSection).toContain("REQUEST CHANGES");
    expect(priorReviewSection).toContain("`src/review.ts`");
    expect(priorReviewSection).not.toContain("alice");
    expect(priorReviewSection).not.toContain("bob");
  });
});

describe("normalizeLabelNames", () => {
  it("handles string labels", () => {
    expect(normalizeLabelNames(["bug", "feature"])).toEqual(["bug", "feature"]);
  });

  it("handles dict labels", () => {
    expect(normalizeLabelNames([{ name: "bug" }, { name: "feature" }])).toEqual(
      ["bug", "feature"],
    );
  });

  it("returns empty for null/undefined", () => {
    expect(normalizeLabelNames(null)).toEqual([]);
    expect(normalizeLabelNames(undefined)).toEqual([]);
  });
});

describe("buildPrReviewPrompt", () => {
  it("uses the tool submission contract by default", () => {
    const prompt = buildPrReviewPrompt({
      prUrl: "https://github.com/acme/hodor/pull/42",
      platform: "github",
      targetBranch: "main",
    });

    expect(prompt).toContain("submit_review");
    expect(prompt).toContain("query_knowledge_base");
    expect(prompt).not.toContain("save_knowledge_base");
    expect(prompt).toContain(
      "Step 1c — Query the knowledge base (MANDATORY — complete before Step 1d):",
    );
    expect(prompt).toContain("pr_understanding");
    expect(prompt).toContain("change_summary");
    expect(prompt).toContain("analysis_scope");
    expect(prompt).toContain("prior_feedback_resolution");
    expect(prompt).toContain("maintainability_assessment");
    expect(prompt).toContain("kb_question_closure");
    expect(prompt).toContain("Execution style constraints (MANDATORY)");
    expect(prompt).toContain(
      "Do not print the review as normal assistant text.",
    );
    expect(prompt).not.toContain("Output ONLY the raw JSON object");
  });

  it("injects prior review section placeholder when metadata exists", () => {
    const prompt = buildPrReviewPrompt({
      prUrl: "https://github.com/acme/hodor/pull/42",
      platform: "github",
      targetBranch: "main",
      mrMetadata: {
        reviewerSummaries: [
          {
            state: "APPROVED",
            body: "Looks good overall.",
            submitted_at: "2026-03-18T10:00:00Z",
          },
        ],
      },
    });

    expect(prompt).toContain("## Prior Review Feedback (GitHub)");
    expect(prompt).not.toContain("{prior_review_section}");
  });
});
