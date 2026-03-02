import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, execJson } from "./utils/exec.js";
import { logger } from "./utils/logger.js";
import { fetchGitlabMrInfo } from "./gitlab.js";
import type { MrMetadata, Platform } from "./types.js";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

interface CiWorkspace {
  path: string | null;
  targetBranch: string | null;
  diffBaseSha: string | null;
}

function detectCiWorkspace(owner: string, repo: string, prNumber: string): CiWorkspace {
  // GitLab CI
  if (process.env.GITLAB_CI === "true") {
    const projectDir = process.env.CI_PROJECT_DIR;
    const projectPath = process.env.CI_PROJECT_PATH;
    const targetBranch = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? null;
    const diffBaseSha = process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? null;

    if (projectDir && projectPath) {
      const expected = `${owner}/${repo}`;
      if (projectPath === expected || projectPath.endsWith(`/${expected}`)) {
        logger.info(`Detected GitLab CI environment (target: ${targetBranch ?? "unknown"})`);
        return { path: projectDir, targetBranch, diffBaseSha };
      }
    }
  }

  // GitHub Actions
  if (process.env.GITHUB_ACTIONS === "true") {
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const repository = process.env.GITHUB_REPOSITORY;
    const baseRef = process.env.GITHUB_BASE_REF ?? null;

    if (workspaceDir && repository) {
      const expected = `${owner}/${repo}`;
      if (repository === expected) {
        logger.info(`Detected GitHub Actions environment (base: ${baseRef ?? "unknown"})`);
        return { path: workspaceDir, targetBranch: baseRef, diffBaseSha: null };
      }
    }
  }

  return { path: null, targetBranch: null, diffBaseSha: null };
}

async function isSameRepo(
  workspace: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd: workspace });
    return stdout.trim().includes(`${owner}/${repo}`);
  } catch {
    return false;
  }
}

export interface WorkspaceResult {
  workspace: string;
  targetBranch: string;
  diffBaseSha: string | null;
}

export async function setupWorkspace(opts: {
  platform: Platform;
  owner: string;
  repo: string;
  prNumber: string;
  host?: string;
  workingDir?: string;
  reuse?: boolean;
}): Promise<WorkspaceResult> {
  const { platform, owner, repo, prNumber, host, workingDir, reuse = true } = opts;

  try {
    const ci = detectCiWorkspace(owner, repo, prNumber);
    let detectedTargetBranch = ci.targetBranch;
    const detectedDiffBaseSha = ci.diffBaseSha;

    let workspace: string;

    if (ci.path) {
      workspace = ci.path;
    } else if (!workingDir) {
      workspace = await mkdtemp(join(tmpdir(), "hodor-review-"));
      logger.info(`Created temporary workspace: ${workspace}`);
    } else {
      workspace = workingDir;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(workspace, { recursive: true });

      if (reuse && (await isSameRepo(workspace, owner, repo))) {
        logger.info(`Reusing existing workspace: ${workspace}`);
        await exec("git", ["fetch", "origin"], { cwd: workspace });
      }
    }

    if (!ci.path) {
      if (platform === "github") {
        const tb = await setupGithubWorkspace(workspace, owner, repo, prNumber);
        if (!detectedTargetBranch) detectedTargetBranch = tb;
      } else if (platform === "gitlab") {
        const tb = await setupGitlabWorkspace(workspace, owner, repo, prNumber, host);
        if (!detectedTargetBranch) detectedTargetBranch = tb;
      } else {
        throw new WorkspaceError(`Unsupported platform: ${platform}`);
      }
    }

    const finalTargetBranch = detectedTargetBranch ?? "main";
    logger.info(
      `Workspace ready at: ${workspace} (target: ${finalTargetBranch}, ` +
      `diff_base_sha: ${detectedDiffBaseSha?.slice(0, 8) ?? "N/A"})`,
    );
    return { workspace, targetBranch: finalTargetBranch, diffBaseSha: detectedDiffBaseSha };
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceError(`Failed to setup workspace: ${msg}`);
  }
}

async function setupGithubWorkspace(
  workspace: string,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<string> {
  logger.info(`Setting up GitHub workspace for ${owner}/${repo}/pull/${prNumber}`);

  // Verify gh CLI
  try {
    await exec("gh", ["version"]);
  } catch {
    throw new WorkspaceError("GitHub CLI (gh) is not available. Install it: https://cli.github.com");
  }

  // Clone
  logger.info(`Cloning repository ${owner}/${repo}...`);
  try {
    await exec("gh", ["repo", "clone", `${owner}/${repo}`, workspace]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceError(`Failed to clone repository ${owner}/${repo}: ${msg}`);
  }

  // Checkout PR
  logger.info(`Checking out PR #${prNumber}...`);
  try {
    await exec("gh", ["pr", "checkout", prNumber], { cwd: workspace });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceError(`Failed to checkout PR #${prNumber}: ${msg}`);
  }

  // Get base branch
  let baseBranch = "main";
  try {
    const prInfo = await execJson<Record<string, string>>(
      "gh",
      ["pr", "view", prNumber, "--json", "headRefName,baseRefName"],
      { cwd: workspace },
    );
    baseBranch = prInfo.baseRefName ?? "main";
    logger.info(`Base branch: ${baseBranch}`);
  } catch {
    logger.warn("Could not fetch PR metadata for base branch detection");
  }

  return baseBranch;
}

async function setupGitlabWorkspace(
  workspace: string,
  owner: string,
  repo: string,
  prNumber: string,
  host?: string,
): Promise<string> {
  const gitlabHost = host || process.env.GITLAB_HOST || "gitlab.com";
  logger.info(`Setting up GitLab workspace for ${owner}/${repo}/merge_requests/${prNumber}`);

  // Verify glab CLI
  try {
    await exec("glab", ["version"]);
  } catch {
    throw new WorkspaceError(
      "GitLab CLI (glab) is not available. Install it: https://gitlab.com/gitlab-org/cli",
    );
  }

  // Clone
  const cloneUrl = `https://${gitlabHost}/${owner}/${repo}.git`;
  logger.info(`Cloning from ${cloneUrl}...`);
  try {
    await exec("git", ["clone", cloneUrl, workspace]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect SSH auth failures (git insteadOf rewrites HTTPS → SSH)
    if (msg.includes("Permission denied") || msg.includes("publickey")) {
      throw new WorkspaceError(
        `Failed to clone ${owner}/${repo}: SSH authentication failed. ` +
        `Ensure your SSH key is available (ssh-add) or configure a GITLAB_TOKEN ` +
        `and use HTTPS: git config --global url."https://oauth2:$GITLAB_TOKEN@${gitlabHost}/".insteadOf "git@${gitlabHost}:"`,
      );
    }
    throw new WorkspaceError(`Failed to clone ${owner}/${repo}: ${msg}`);
  }

  // Fetch MR info for source/target branch
  let mrInfo: MrMetadata;
  try {
    mrInfo = await fetchGitlabMrInfo(owner, repo, Number(prNumber), gitlabHost);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceError(`Failed to fetch MR info for !${prNumber}: ${msg}`);
  }

  const sourceBranch = mrInfo.source_branch;
  const targetBranch = mrInfo.target_branch ?? "main";

  if (!sourceBranch) {
    throw new WorkspaceError(`Could not determine source branch for MR !${prNumber}`);
  }

  logger.info(`Source branch: ${sourceBranch}, Target branch: ${targetBranch}`);

  // Checkout source branch
  try {
    await exec("git", ["checkout", "-b", sourceBranch, `origin/${sourceBranch}`], {
      cwd: workspace,
    });
  } catch {
    try {
      await exec("git", ["checkout", sourceBranch], { cwd: workspace });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkspaceError(`Failed to checkout MR branch '${sourceBranch}': ${msg}`);
    }
  }

  return targetBranch;
}

export async function cleanupWorkspace(workspace: string): Promise<void> {
  try {
    await rm(workspace, { recursive: true, force: true });
    logger.info(`Cleaned up workspace: ${workspace}`);
  } catch (err) {
    logger.warn(`Failed to cleanup workspace ${workspace}: ${err}`);
  }
}
