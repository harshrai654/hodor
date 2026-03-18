/**
 * Render structured review output into clean markdown for PR/MR comments.
 */

import type { RenderContext, ReviewFinding, ReviewOutput } from "./types.js";

/**
 * Render a ReviewOutput into clean markdown for posting as a PR/MR comment.
 */
export function renderMarkdown(review: ReviewOutput, context?: RenderContext): string {
  const lines: string[] = [];

  // Group findings by priority
  const critical: ReviewFinding[] = []; // P0, P1
  const important: ReviewFinding[] = []; // P2
  const minor: ReviewFinding[] = []; // P3

  for (const f of review.findings) {
    const p = f.priority;
    if (p <= 1) critical.push(f);
    else if (p === 2) important.push(f);
    else minor.push(f);
  }

  appendSection(lines, "PR Understanding", review.pr_understanding);
  appendSection(lines, "Change Summary", review.change_summary);
  appendSection(lines, "Scope & Assumptions", review.analysis_scope);
  appendSection(lines, "Prior Feedback Resolution", review.prior_feedback_resolution);
  if (review.maintainability_assessment?.trim()) {
    lines.push("### Maintainability Assessment");
    lines.push(`- ${review.maintainability_assessment.trim()}`);
    lines.push("");
  }
  appendSection(lines, "Confidence Notes", review.confidence_notes);
  if (review.kb_question_closure?.trim()) {
    lines.push("### Knowledge Closure");
    lines.push(`- ${review.kb_question_closure.trim()}`);
    lines.push("");
  }

  lines.push("### Issues Found");
  lines.push("");

  if (review.findings.length === 0) {
    lines.push("No issues found.");
    lines.push("");
  }

  if (critical.length > 0) {
    lines.push("**Critical (P0/P1)**");
    for (const f of critical) {
      lines.push(formatFinding(f, context));
    }
    lines.push("");
  }

  if (important.length > 0) {
    lines.push("**Important (P2)**");
    for (const f of important) {
      lines.push(formatFinding(f, context));
    }
    lines.push("");
  }

  if (minor.length > 0) {
    lines.push("**Minor (P3)**");
    for (const f of minor) {
      lines.push(formatFinding(f, context));
    }
    lines.push("");
  }

  // Summary
  lines.push("### Summary");
  lines.push(
    `Total issues: ${critical.length} critical, ${important.length} important, ${minor.length} minor.`,
  );
  lines.push("");

  // Overall verdict
  lines.push("### Overall Verdict");
  const isCorrect = review.overall_correctness === "patch is correct";
  lines.push(
    `**Status**: ${isCorrect ? "Patch is correct" : "Patch has blocking issues"}`,
  );
  lines.push("");
  if (review.overall_explanation) {
    lines.push(`**Explanation**: ${review.overall_explanation}`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

function appendSection(lines: string[], title: string, items: string[] | undefined): void {
  if (!items || items.length === 0) return;
  lines.push(`### ${title}`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

function formatFinding(f: ReviewFinding, context?: RenderContext): string {
  const loc = ` (${formatLocation(f.code_location, context)})`;
  const title = `- **${f.title}**${loc}`;
  const body = `  - ${f.body}`;
  return `${title}\n${body}`;
}

function formatLocation(loc: {
  absolute_file_path: string;
  line_range: { start: number; end: number };
}, context?: RenderContext): string {
  const relativePath = toRelativePath(loc.absolute_file_path);
  const { start, end } = loc.line_range;
  const label = start === end ? `${relativePath}:${start}` : `${relativePath}:${start}-${end}`;
  const href = buildLocationUrl(context, relativePath, start, end);
  return href ? `[${label}](${href})` : `\`${label}\``;
}

function toRelativePath(absolutePath: string): string {
  // Strip common workspace prefixes to get a clean relative path
  let filePath = absolutePath;

  // GitLab CI: /builds/owner/repo/src/file.ts → src/file.ts
  const buildsMatch = filePath.match(/\/builds\/[^/]+\/[^/]+\/(.+)/);
  if (buildsMatch) {
    filePath = buildsMatch[1];
  }
  // GitHub Actions / generic workspace
  else if (filePath.includes("/workspace/")) {
    filePath = filePath.slice(filePath.indexOf("/workspace/") + "/workspace/".length);
  }
  // GitHub Actions hosted runners: /home/runner/work/repo/repo/src/file.ts → src/file.ts
  else {
    const ghaMatch = filePath.match(/\/home\/runner\/work\/[^/]+\/[^/]+\/(.+)/);
    if (ghaMatch) {
      filePath = ghaMatch[1];
    } else {
      // Temp review dirs: /tmp/hodor-review-<id>/src/file.ts → src/file.ts
      filePath = filePath.replace(/^.*\/hodor-review-[^/]+\//, "");
    }
  }

  return filePath;
}

function buildLocationUrl(
  context: RenderContext | undefined,
  relativePath: string,
  start: number,
  end: number,
): string | null {
  if (!context?.repoUrl || !context.sourceRef) return null;
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const encodedRef = encodeURIComponent(context.sourceRef);
  const anchor = start === end ? `#L${start}` : `#L${start}-L${end}`;

  if (context.platform === "github") {
    return `${context.repoUrl}/blob/${encodedRef}/${encodedPath}${anchor}`;
  }
  if (context.platform === "gitlab") {
    return `${context.repoUrl}/-/blob/${encodedRef}/${encodedPath}${anchor}`;
  }
  return null;
}
