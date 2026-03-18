import { logger } from "./utils/logger.js";
import { execJson } from "./utils/exec.js";
import type {
  InlineReviewComment,
  MrMetadata,
  NoteEntry,
  ReviewerSummary,
} from "./types.js";

export class GitHubAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAPIError";
  }
}

export async function fetchGithubPrInfo(
  owner: string,
  repo: string,
  prNumber: number | string,
): Promise<Record<string, unknown>> {
  const fields = [
    "number",
    "title",
    "body",
    "author",
    "baseRefName",
    "headRefName",
    "baseRefOid",
    "headRefOid",
    "changedFiles",
    "labels",
    "comments",
    "reviews",
    "latestReviews",
    "state",
    "isDraft",
    "createdAt",
    "updatedAt",
    "mergeable",
    "url",
  ];

  const repoFullPath = `${owner}/${repo}`;
  try {
    const prData = await execJson<Record<string, unknown>>("gh", [
      "pr",
      "view",
      String(prNumber),
      "-R",
      repoFullPath,
      "--json",
      fields.join(","),
    ]);

    // gh pr view does not always include complete inline review thread comments.
    // Fetch line-level review comments explicitly and merge into payload.
    try {
      const inlineReviewComments = await execJson<
        Array<Record<string, unknown>>
      >("gh", [
        "api",
        `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        "--paginate",
      ]);
      prData.inlineReviewComments = inlineReviewComments;
    } catch (inlineErr) {
      logger.warn(
        `Failed to fetch GitHub inline review comments for PR #${prNumber}: ${
          inlineErr instanceof Error ? inlineErr.message : String(inlineErr)
        }`,
      );
    }

    return prData;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GitHubAPIError(msg);
  }
}

export function normalizeGithubMetadata(
  raw: Record<string, unknown>,
): MrMetadata {
  const author = (raw.author as Record<string, string>) ?? {};
  const labels = (raw.labels as Array<Record<string, string>>) ?? [];
  const comments = raw.comments as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  const reviews = (raw.reviews ?? raw.latestReviews) as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  const inlineReviewComments = raw.inlineReviewComments as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;

  const discussionComments = githubCommentsToNotes(comments);

  return {
    title: raw.title as string | undefined,
    description: (raw.body as string) ?? "",
    source_branch: raw.headRefName as string | undefined,
    target_branch: raw.baseRefName as string | undefined,
    changes_count: raw.changedFiles as number | undefined,
    labels: labels.map((lbl) => ({ name: lbl.name ?? lbl.id })),
    author: {
      username: author.login ?? author.name,
      name: author.name,
    },
    Notes: discussionComments,
    discussionComments,
    reviewerSummaries: githubReviewsToSummaries(reviews),
    inlineReviewComments:
      githubInlineReviewCommentsToEntries(inlineReviewComments),
  };
}

function githubCommentsToNotes(
  comments:
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined
    | null,
): NoteEntry[] {
  if (!comments) return [];

  let nodes: Array<Record<string, unknown>>;
  if (Array.isArray(comments)) {
    nodes = comments;
  } else if (typeof comments === "object") {
    nodes =
      (comments.nodes as Array<Record<string, unknown>>) ??
      (comments.edges as Array<Record<string, unknown>>) ??
      [];
    // Handle GraphQL edge format
    if (
      nodes.length > 0 &&
      typeof nodes[0] === "object" &&
      "node" in nodes[0]
    ) {
      nodes = nodes.map((edge) => (edge.node as Record<string, unknown>) ?? {});
    }
  } else {
    nodes = [];
  }

  return nodes.map((node) => {
    const author = (node.author as Record<string, string>) ?? {};
    return {
      body: (node.body as string) ?? "",
      author: {
        username: author.login ?? author.name,
        name: author.name,
      },
      created_at: node.createdAt as string | undefined,
    };
  });
}

function githubReviewsToSummaries(
  reviews:
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined
    | null,
): ReviewerSummary[] {
  if (!reviews) return [];

  let nodes: Array<Record<string, unknown>>;
  if (Array.isArray(reviews)) {
    nodes = reviews;
  } else if (typeof reviews === "object") {
    nodes =
      (reviews.nodes as Array<Record<string, unknown>>) ??
      (reviews.edges as Array<Record<string, unknown>>) ??
      [];
    if (
      nodes.length > 0 &&
      typeof nodes[0] === "object" &&
      "node" in nodes[0]
    ) {
      nodes = nodes.map((edge) => (edge.node as Record<string, unknown>) ?? {});
    }
  } else {
    nodes = [];
  }

  return nodes.map((node) => {
    const reviewAuthor = (node.author as Record<string, string>) ?? {};
    return {
      body: (node.body as string) ?? "",
      state: (node.state as string) ?? "",
      author: {
        username: reviewAuthor.login ?? reviewAuthor.name,
        name: reviewAuthor.name,
      },
      submitted_at:
        (node.submittedAt as string) ?? (node.createdAt as string) ?? "",
    };
  });
}

function githubInlineReviewCommentsToEntries(
  comments:
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined
    | null,
): InlineReviewComment[] {
  if (!comments) return [];

  let nodes: Array<Record<string, unknown>>;
  if (Array.isArray(comments)) {
    nodes = comments;
  } else if (typeof comments === "object") {
    nodes =
      (comments.nodes as Array<Record<string, unknown>>) ??
      (comments.edges as Array<Record<string, unknown>>) ??
      [];
    if (
      nodes.length > 0 &&
      typeof nodes[0] === "object" &&
      "node" in nodes[0]
    ) {
      nodes = nodes.map((edge) => (edge.node as Record<string, unknown>) ?? {});
    }
  } else {
    nodes = [];
  }

  return nodes.map((node) => {
    const commentAuthor =
      ((node.user ?? node.author) as Record<string, string>) ?? {};
    const line = node.line;
    const originalLine = node.original_line;
    const parsedLine =
      typeof line === "number"
        ? line
        : typeof originalLine === "number"
          ? originalLine
          : undefined;

    return {
      body: (node.body as string) ?? "",
      path: (node.path as string) ?? "",
      line: parsedLine,
      side: (node.side as string) ?? "",
      author: {
        username: commentAuthor.login ?? commentAuthor.name,
        name: commentAuthor.name,
      },
      created_at:
        (node.created_at as string) ?? (node.createdAt as string) ?? "",
    };
  });
}
