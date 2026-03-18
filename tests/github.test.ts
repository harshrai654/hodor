import { beforeEach, describe, expect, it, vi } from "vitest";

const execJsonMock = vi.fn();
const warnMock = vi.fn();

vi.mock("../src/utils/exec.js", () => ({
  execJson: execJsonMock,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    warn: warnMock,
  },
}));

describe("normalizeGithubMetadata", () => {
  it("maps discussion comments, reviewer summaries, and inline comments", async () => {
    const { normalizeGithubMetadata } = await import("../src/github.js");

    const metadata = normalizeGithubMetadata({
      title: "Test PR",
      body: "PR description",
      headRefName: "feature/prior-review-context",
      baseRefName: "main",
      changedFiles: 3,
      author: { login: "author-user", name: "Author User" },
      labels: [{ name: "bug" }],
      comments: {
        nodes: [
          {
            body: "General PR conversation.",
            author: { login: "commenter" },
            createdAt: "2026-03-18T10:00:00Z",
          },
        ],
      },
      reviews: {
        nodes: [
          {
            state: "REQUEST_CHANGES",
            body: "Please guard the null payload case.",
            author: { login: "reviewer" },
            submittedAt: "2026-03-18T11:00:00Z",
          },
        ],
      },
      inlineReviewComments: [
        {
          body: "Potential null dereference.",
          path: "src/review.ts",
          line: 42,
          side: "RIGHT",
          user: { login: "inline-reviewer" },
          created_at: "2026-03-18T11:05:00Z",
        },
      ],
    });

    expect(metadata.description).toBe("PR description");
    expect(metadata.Notes).toHaveLength(1);
    expect(metadata.discussionComments).toHaveLength(1);
    expect(metadata.reviewerSummaries).toHaveLength(1);
    expect(metadata.reviewerSummaries?.[0]?.state).toBe("REQUEST_CHANGES");
    expect(metadata.inlineReviewComments).toHaveLength(1);
    expect(metadata.inlineReviewComments?.[0]?.path).toBe("src/review.ts");
  });
});

describe("fetchGithubPrInfo", () => {
  beforeEach(() => {
    execJsonMock.mockReset();
    warnMock.mockReset();
  });

  it("fetches inline review comments and merges them into PR payload", async () => {
    const { fetchGithubPrInfo } = await import("../src/github.js");

    execJsonMock
      .mockResolvedValueOnce({ title: "My PR" })
      .mockResolvedValueOnce([{ body: "Inline note" }]);

    const raw = await fetchGithubPrInfo("acme", "hodor", 42);

    expect(execJsonMock).toHaveBeenCalledTimes(2);
    expect(raw.title).toBe("My PR");
    expect(raw.inlineReviewComments).toEqual([{ body: "Inline note" }]);
  });

  it("continues when inline review comment fetch fails", async () => {
    const { fetchGithubPrInfo } = await import("../src/github.js");

    execJsonMock
      .mockResolvedValueOnce({ title: "My PR" })
      .mockRejectedValueOnce(new Error("inline fetch failed"));

    const raw = await fetchGithubPrInfo("acme", "hodor", 42);

    expect(raw.title).toBe("My PR");
    expect(raw.inlineReviewComments).toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
