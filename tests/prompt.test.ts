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
});

describe("normalizeLabelNames", () => {
  it("handles string labels", () => {
    expect(normalizeLabelNames(["bug", "feature"])).toEqual([
      "bug",
      "feature",
    ]);
  });

  it("handles dict labels", () => {
    expect(
      normalizeLabelNames([{ name: "bug" }, { name: "feature" }]),
    ).toEqual(["bug", "feature"]);
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
    expect(prompt).toContain("save_knowledge_base");
    expect(prompt).toContain("Step 1c — Query durable prior knowledge (MANDATORY)");
    expect(prompt).toContain("MUST call `query_knowledge_base` at least once");
    expect(prompt).toContain("call `save_knowledge_base` at least once before `submit_review`");
    expect(prompt).toContain("Allowed `save_knowledge_base` categories");
    expect(prompt).toContain("`architecture`");
    expect(prompt).toContain("`coding_pattern`");
    expect(prompt).toContain("`service_call_chain`");
    expect(prompt).toContain("`fundamental_design`");
    expect(prompt).toContain("Do not save one-off implementation details");
    expect(prompt).toContain("final PR review comments/findings text");
    expect(prompt).toContain("Do not print the review as normal assistant text.");
    expect(prompt).not.toContain("Output ONLY the raw JSON object");
  });
});
