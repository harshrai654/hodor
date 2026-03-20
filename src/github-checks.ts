import { logger } from "./utils/logger.js";

export type GitHubCheckRunStatus = "in_progress" | "completed";
export type GitHubCheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required";

export interface CreateCheckRunOptions {
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  token: string;
  summary?: string;
  detailsUrl?: string;
}

export interface UpdateCheckRunOptions {
  owner: string;
  repo: string;
  checkRunId: number;
  token: string;
  status: GitHubCheckRunStatus;
  conclusion?: GitHubCheckRunConclusion;
  title?: string;
  summary?: string;
  text?: string;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

async function ghApi<T>(
  url: string,
  token: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body}`);
  }

  return (await res.json()) as T;
}

export async function createCheckRun(
  opts: CreateCheckRunOptions,
): Promise<number> {
  const { owner, repo, headSha, name, token, summary, detailsUrl } = opts;
  const safeSummary = summary ? truncate(summary, 5000) : undefined;

  const data = await ghApi<{ id: number }>(
    `https://api.github.com/repos/${owner}/${repo}/check-runs`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        head_sha: headSha,
        status: "in_progress",
        details_url: detailsUrl,
        output: {
          title: name,
          ...(safeSummary ? { summary: safeSummary } : {}),
        },
      }),
    },
  );

  return data.id;
}

export async function updateCheckRun(
  opts: UpdateCheckRunOptions,
): Promise<void> {
  const {
    owner,
    repo,
    checkRunId,
    token,
    status,
    conclusion,
    title,
    summary,
    text,
  } = opts;

  const safeSummary = summary ? truncate(summary, 5000) : undefined;
  const safeText = text ? truncate(text, 65000) : undefined;

  await ghApi(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({
        status,
        ...(conclusion ? { conclusion } : {}),
        ...(title || safeSummary || safeText
          ? {
              output: {
                ...(title ? { title } : {}),
                ...(safeSummary ? { summary: safeSummary } : {}),
                ...(safeText ? { text: safeText } : {}),
              },
            }
          : {}),
      }),
    },
  );
}

export class GitHubCheckRunProgress {
  private lastUpdateAt = 0;
  private lastStage = "";
  private isComplete = false;

  constructor(
    private readonly args: {
      owner: string;
      repo: string;
      token: string;
      checkRunId: number;
      title: string;
      throttleMs: number;
    },
  ) {}

  async setStage(stage: string, summary?: string): Promise<void> {
    if (this.isComplete) return;

    const now = Date.now();
    const stageChanged = stage !== this.lastStage;
    const throttlePassed = now - this.lastUpdateAt >= this.args.throttleMs;
    if (!stageChanged && !throttlePassed) return;

    this.lastStage = stage;
    this.lastUpdateAt = now;

    const finalSummary = summary ?? stage;
    try {
      await updateCheckRun({
        owner: this.args.owner,
        repo: this.args.repo,
        checkRunId: this.args.checkRunId,
        token: this.args.token,
        status: "in_progress",
        title: this.args.title,
        summary: finalSummary,
      });
    } catch (err) {
      logger.warn(
        `Failed to update check run summary (${this.args.title}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async complete(conclusion: GitHubCheckRunConclusion, summary?: string) {
    if (this.isComplete) return;
    this.isComplete = true;

    try {
      await updateCheckRun({
        owner: this.args.owner,
        repo: this.args.repo,
        checkRunId: this.args.checkRunId,
        token: this.args.token,
        status: "completed",
        conclusion,
        title: this.args.title,
        summary: summary ?? conclusion,
      });
    } catch (err) {
      logger.warn(
        `Failed to complete check run (${this.args.title}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

