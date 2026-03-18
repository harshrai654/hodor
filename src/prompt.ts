import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./utils/logger.js";
import { summarizeGitlabNotes } from "./gitlab.js";
import type { MrMetadata, Platform } from "./types.js";

// Resolve templates directory relative to this file (works in both src/ and dist/)
function getTemplatesDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "..", "templates");
}

export function buildPrReviewPrompt(opts: {
  prUrl: string;
  platform: Platform;
  targetBranch?: string;
  diffBaseSha?: string | null;
  mrMetadata?: MrMetadata | null;
  customInstructions?: string | null;
  customPromptFile?: string | null;
}): string {
  const {
    prUrl,
    platform,
    targetBranch = "main",
    diffBaseSha,
    mrMetadata,
    customInstructions,
    customPromptFile,
  } = opts;

  // Step 1: Determine template (always tool submission; rendered to markdown post-hoc)
  let templateFile: string;
  if (customPromptFile) {
    templateFile = customPromptFile;
    logger.info(`Using custom prompt file: ${templateFile}`);
  } else {
    templateFile = resolve(getTemplatesDir(), "tool-review.md");
    logger.info("Using tool-based review template");
  }

  // Step 2: Load template
  let templateText: string;
  try {
    templateText = readFileSync(templateFile, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to load prompt template from ${templateFile}: ${err}`,
    );
  }

  // Validate ref inputs to prevent shell injection via branch/SHA names.
  // Block shell metacharacters while allowing valid git ref chars (@, +, ~, ^, etc.)
  const dangerousChars = /[;\|`$&<>(){}\n\r\0\\!]/;
  if (dangerousChars.test(targetBranch)) {
    throw new Error(`Invalid target branch name: ${targetBranch}`);
  }
  if (diffBaseSha && dangerousChars.test(diffBaseSha)) {
    throw new Error(`Invalid diff base SHA: ${diffBaseSha}`);
  }

  // Prepare platform-specific commands
  let prDiffCmd: string;
  let gitDiffCmd: string;
  let inspectDiffCmd: string;

  if (platform === "github") {
    prDiffCmd = `git --no-pager diff origin/${targetBranch}...HEAD --name-only`;
    gitDiffCmd = `git --no-pager diff origin/${targetBranch}...HEAD`;
    // Use merge-base so inspect range matches git's three-dot semantics (PR changes only).
    // --format markdown is designed for agents. --min-risk medium filters out cosmetic-only entities.
    inspectDiffCmd = `inspect diff $(git merge-base origin/${targetBranch} HEAD)..HEAD --format markdown --min-risk medium`;
  } else {
    // gitlab
    if (diffBaseSha) {
      prDiffCmd = `git --no-pager diff ${diffBaseSha} HEAD --name-only`;
      gitDiffCmd = `git --no-pager diff ${diffBaseSha} HEAD`;
      // diffBaseSha is already the exact merge base from CI_MERGE_REQUEST_DIFF_BASE_SHA
      inspectDiffCmd = `inspect diff ${diffBaseSha}..HEAD --format markdown --min-risk medium`;
      logger.info(
        `Using GitLab CI_MERGE_REQUEST_DIFF_BASE_SHA: ${diffBaseSha.slice(0, 8)}`,
      );
    } else {
      prDiffCmd = `git --no-pager diff origin/${targetBranch}...HEAD --name-only`;
      gitDiffCmd = `git --no-pager diff origin/${targetBranch}...HEAD`;
      inspectDiffCmd = `inspect diff $(git merge-base origin/${targetBranch} HEAD)..HEAD --format markdown --min-risk medium`;
    }
  }

  // Diff explanation
  let diffExplanation: string;
  if (diffBaseSha) {
    diffExplanation =
      `**GitLab CI Advantage**: This uses GitLab's pre-calculated merge base SHA ` +
      `(\`CI_MERGE_REQUEST_DIFF_BASE_SHA\`), which matches exactly what the GitLab UI shows. ` +
      `This is more reliable than three-dot syntax because it handles force pushes, rebases, ` +
      `and messy histories correctly.`;
  } else {
    diffExplanation =
      `**Three-dot syntax** shows ONLY changes introduced on the source branch, ` +
      `excluding changes already on \`${targetBranch}\`.`;
  }

  // Step 3: Build MR sections
  const { contextSection, notesSection, priorReviewSection, reminderSection } =
    buildMrSections(mrMetadata);

  // Step 4: Interpolate
  let prompt = templateText
    .replace(/\{pr_url\}/g, prUrl)
    .replace(/\{pr_diff_cmd\}/g, prDiffCmd)
    .replace(/\{git_diff_cmd\}/g, gitDiffCmd)
    .replace(/\{inspect_diff_cmd\}/g, inspectDiffCmd)
    .replace(/\{target_branch\}/g, targetBranch)
    .replace(/\{diff_explanation\}/g, diffExplanation)
    .replace(/\{mr_context_section\}/g, contextSection)
    .replace(/\{mr_notes_section\}/g, notesSection)
    .replace(/\{prior_review_section\}/g, priorReviewSection)
    .replace(/\{mr_reminder_section\}/g, reminderSection);

  // Step 5: Append custom instructions
  if (customInstructions) {
    prompt += `\n\n## Additional Instructions\n\n${customInstructions}\n`;
    logger.info("Appended custom instructions to prompt");
  }

  return prompt;
}

export function buildMrSections(mrMetadata?: MrMetadata | null): {
  contextSection: string;
  notesSection: string;
  priorReviewSection: string;
  reminderSection: string;
} {
  if (!mrMetadata) {
    return {
      contextSection: "",
      notesSection: "",
      priorReviewSection: "",
      reminderSection: "",
    };
  }

  const contextLines: string[] = [];

  if (mrMetadata.title) {
    contextLines.push(`- Title: ${mrMetadata.title}`);
  }

  const author = mrMetadata.author?.username ?? mrMetadata.author?.name;
  if (author) {
    contextLines.push(`- Author: @${author}`);
  }

  if (mrMetadata.source_branch && mrMetadata.target_branch) {
    contextLines.push(
      `- Branches: ${mrMetadata.source_branch} → ${mrMetadata.target_branch}`,
    );
  }

  if (mrMetadata.changes_count) {
    contextLines.push(`- Files changed: ${mrMetadata.changes_count}`);
  }

  const pipelineStatus = mrMetadata.pipeline?.status;
  const pipelineUrl = mrMetadata.pipeline?.web_url;
  if (pipelineStatus) {
    const statusText = pipelineStatus.replace(/_/g, " ");
    contextLines.push(
      pipelineUrl
        ? `- Pipeline: ${statusText} (${pipelineUrl})`
        : `- Pipeline: ${statusText}`,
    );
  }

  let labelNames = normalizeLabelNames(mrMetadata.label_details);
  if (labelNames.length === 0) {
    labelNames = normalizeLabelNames(mrMetadata.labels);
  }
  if (labelNames.length > 0) {
    contextLines.push(`- Labels: ${labelNames.join(", ")}`);
  }

  const description = (mrMetadata.description ?? "").trim();
  let descriptionSection = "";
  if (description) {
    descriptionSection =
      "**Author Description:**\n" + truncateBlock(description, 800);
  }

  let contextSection = "";
  if (contextLines.length > 0 || descriptionSection) {
    contextSection = "## MR Context\n" + contextLines.join("\n");
    if (descriptionSection) {
      contextSection += "\n\n" + descriptionSection;
    }
    contextSection += "\n";
  }

  let notesSection = "";
  const notesSummary = summarizeGitlabNotes(mrMetadata.Notes);
  if (notesSummary) {
    notesSection = `## Existing MR Notes\n${notesSummary}\n`;
  }

  let priorReviewSection = "";
  const priorReviewSummary = summarizeGithubPriorReviewFeedback(mrMetadata);
  if (priorReviewSummary) {
    priorReviewSection =
      `## Prior Review Feedback (GitHub)\n${priorReviewSummary}\n`;
  }

  let reminderSection = "";
  if (notesSummary || priorReviewSummary) {
    reminderSection =
      "## Review Note Deduplication\n\n" +
      "The discussions above may already cover some issues. Before reporting a finding:\n" +
      "1. Check if it's already mentioned in existing notes\n" +
      "2. Only report if your finding is materially different or more specific\n" +
      "3. If an existing note is incorrect/outdated, explain why in your finding\n\n" +
      "Focus on discovering NEW issues not yet discussed.\n";
  }

  return { contextSection, notesSection, priorReviewSection, reminderSection };
}

function truncateBlock(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit - 1).trimEnd() + "…";
}

export function normalizeLabelNames(rawLabels: unknown): string[] {
  if (!rawLabels) return [];

  const names: string[] = [];

  function addLabel(value: unknown): void {
    let name = "";
    if (typeof value === "string") {
      name = value.trim();
    } else if (typeof value === "object" && value !== null) {
      const labelValue = (value as Record<string, unknown>).name;
      if (typeof labelValue === "string") {
        name = labelValue.trim();
      }
    } else if (value != null) {
      name = String(value).trim();
    }
    if (name) names.push(name);
  }

  if (Array.isArray(rawLabels)) {
    for (const label of rawLabels) addLabel(label);
  } else {
    addLabel(rawLabels);
  }

  return names;
}

function summarizeGithubPriorReviewFeedback(mrMetadata: MrMetadata): string {
  const lines: string[] = [];
  const reviews = (mrMetadata.reviewerSummaries ?? []).filter(
    (review) => (review.body ?? "").trim().length > 0 || (review.state ?? "").trim().length > 0,
  );
  const inlineComments = (mrMetadata.inlineReviewComments ?? []).filter(
    (comment) => (comment.body ?? "").trim().length > 0,
  );

  if (reviews.length > 0) {
    lines.push("### Review decisions");
    const orderedReviews = [...reviews].sort((a, b) =>
      (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""),
    );
    const recentReviews = orderedReviews.slice(-5);
    for (const review of recentReviews) {
      const state = normalizeReviewState(review.state);
      const timestamp = formatTimestamp(review.submitted_at);
      const body = truncateBlock((review.body ?? "").trim(), 180);
      const header = timestamp ? `- ${state} (${timestamp})` : `- ${state}`;
      if (body) {
        lines.push(`${header}: ${body}`);
      } else {
        lines.push(header);
      }
    }
  }

  if (inlineComments.length > 0) {
    lines.push("### Inline review thread excerpts");
    const grouped = new Map<string, string[]>();
    const orderedInline = [...inlineComments].sort((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    );
    const recentInline = orderedInline.slice(-12);

    for (const comment of recentInline) {
      const path = (comment.path ?? "").trim() || "unknown-file";
      const body = truncateBlock((comment.body ?? "").trim(), 150);
      if (!body) continue;

      const linePart =
        typeof comment.line === "number" && Number.isFinite(comment.line)
          ? `line ${comment.line}`
          : "line ?";
      const sidePart = comment.side ? ` (${comment.side})` : "";
      const item = `- ${linePart}${sidePart}: ${body}`;
      const entries = grouped.get(path) ?? [];
      if (entries.length < 3) {
        entries.push(item);
        grouped.set(path, entries);
      }
    }

    let emittedFiles = 0;
    for (const [path, entries] of grouped.entries()) {
      if (emittedFiles >= 4) break;
      lines.push(`- \`${path}\``);
      lines.push(...entries.map((entry) => `  ${entry}`));
      emittedFiles += 1;
    }
  }

  return lines.join("\n");
}

function normalizeReviewState(state?: string): string {
  const normalized = (state ?? "").trim().toUpperCase();
  if (!normalized) return "COMMENTED";
  return normalized.replace(/_/g, " ");
}

function formatTimestamp(ts?: string): string {
  if (!ts) return "";
  try {
    const dt = new Date(ts);
    return dt.toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return ts.slice(0, 16);
  }
}
