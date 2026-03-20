#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import "dotenv/config";

import {
  detectPlatform,
  parsePrUrl,
  postFeedbackComment,
  postReviewComment,
  reviewPr,
} from "./agent.js";
import type { AgentProgressEvent } from "./agent.js";
import { renderMarkdown } from "./render.js";
import { setLogLevel } from "./utils/logger.js";
import { formatKnowledgeExtractionMarkdown } from "./metrics.js";

const program = new Command();

program
  .name("hodor")
  .description(
    "AI-powered code review agent for GitHub PRs and GitLab MRs.\n\n" +
      "Hodor uses an AI agent that clones the repository, checks out the PR branch,\n" +
      "and analyzes the code using tools (gh, git, glab) for metadata fetching and comment posting.",
  )
  .version("0.3.4")
  .enablePositionalOptions();

// --- Default review command (hodor <pr-url>) ---
program
  .argument("<pr-url>", "URL of the GitHub PR or GitLab MR to review")
  .option(
    "--model <model>",
    "LLM model to use (e.g., anthropic/claude-sonnet-4-5-20250929, openai/gpt-5)",
    "anthropic/claude-sonnet-4-5-20250929",
  )
  .option(
    "--reasoning-effort <level>",
    "Reasoning effort level: low, medium, high, xhigh",
  )
  .option("-v, --verbose", "Enable verbose logging", false)
  .option("--post", "Post the review directly to the PR/MR as a comment", false)
  .option("--prompt <text>", "Custom inline prompt text")
  .option(
    "--prompt-file <path>",
    "Path to file containing custom prompt instructions",
  )
  .option(
    "--workspace <dir>",
    "Workspace directory (creates temp dir if not specified)",
  )
  .option(
    "--ultrathink",
    "Enable maximum reasoning effort with extended thinking budget",
    false,
  )
  .action(async (prUrl: string, cmdOpts: Record<string, unknown>) => {
    const verbose = cmdOpts.verbose as boolean;
    const post = cmdOpts.post as boolean;
    const model = cmdOpts.model as string;
    let reasoningEffort = cmdOpts.reasoningEffort as string | undefined;
    const prompt = cmdOpts.prompt as string | undefined;
    const promptFile = cmdOpts.promptFile as string | undefined;
    const workspace = cmdOpts.workspace as string | undefined;
    const ultrathink = cmdOpts.ultrathink as boolean;

    // Auto-detect CI environment
    const isCI = !!(
      process.env.CI ||
      process.env.GITLAB_CI ||
      process.env.GITHUB_ACTIONS
    );

    if (verbose) setLogLevel("debug");
    else if (isCI) setLogLevel("info");

    // Handle ultrathink
    if (ultrathink) {
      reasoningEffort = "high";
    }

    const log = console.log;
    const logStream = process.stdout;

    const toolIcons: Record<string, string> = {
      bash: "$",
      read: "cat",
      grep: "grep",
      find: "find",
      ls: "ls",
      query_knowledge_base: "kb?",
      save_knowledge_base: "kb+",
    };

    /** Write a line to the log stream */
    function streamLog(msg: string): void {
      logStream.write(`${msg}\n`);
    }

    /** Write inline text (no newline) for streaming deltas */
    function streamWrite(text: string): void {
      process.stderr.write(text);
    }

    function handleEvent(event: AgentProgressEvent): void {
      switch (event.type) {
        case "agent_start":
          streamLog(chalk.dim("▶ Agent started"));
          break;
        case "turn_start":
          streamLog(chalk.dim(`\n── Turn ${event.turnIndex ?? "?"} ──`));
          break;
        case "tool_start": {
          const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
          const preview = event.toolArgs ? ` ${event.toolArgs}` : "";
          const maxLen = 160;
          const truncated =
            preview.length > maxLen ? preview.slice(0, maxLen) + "…" : preview;
          streamLog(chalk.green(`  ${icon}${truncated}`));
          break;
        }
        case "tool_end": {
          if (event.isError) {
            streamLog(chalk.red(`  ✗ error`));
          }
          if (event.result) {
            const lines = event.result.split("\n");
            const maxLines = verbose ? 15 : 6;
            const maxChars = verbose ? 400 : 200;
            let chars = 0;
            for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
              const line = lines[i];
              if (chars + line.length > maxChars) {
                streamLog(chalk.dim(`    …(${lines.length - i} more lines)`));
                break;
              }
              streamLog(chalk.dim(`    ${line}`));
              chars += line.length;
            }
          }
          break;
        }
        case "text_delta":
          if (verbose && event.delta) {
            streamWrite(event.delta);
          }
          break;
        case "thinking_delta":
          // Only show reasoning in verbose mode
          if (verbose && event.delta) {
            streamWrite(chalk.dim(event.delta));
          }
          break;
        case "agent_end":
          streamLog(chalk.dim("\n▶ Extracting review..."));
          break;
      }
    }

    try {
      // Validate URL and detect platform (inside try so errors are caught)
      const platform = detectPlatform(prUrl);
      const githubToken = process.env.GITHUB_TOKEN;
      const gitlabToken =
        process.env.GITLAB_TOKEN ??
        process.env.GITLAB_PRIVATE_TOKEN ??
        process.env.CI_JOB_TOKEN;

      if (platform === "github" && !githubToken) {
        console.error(
          chalk.yellow(
            "Warning: GITHUB_TOKEN not set. You may encounter rate limits or authentication issues.",
          ),
        );
        console.error(
          chalk.dim(
            "  Set GITHUB_TOKEN environment variable or run: gh auth login\n",
          ),
        );
      } else if (platform === "gitlab" && !gitlabToken) {
        console.error(
          chalk.yellow(
            "Warning: No GitLab token detected. Set GITLAB_TOKEN (api scope) for authentication.",
          ),
        );
        console.error(
          chalk.dim(
            "  Export GITLAB_TOKEN and optionally GITLAB_HOST for self-hosted instances.\n",
          ),
        );
      }

      log(`\n${chalk.bold.cyan("Hodor - AI Code Review Agent")}`);
      log(chalk.dim(`Platform: ${platform.toUpperCase()}`));
      log(chalk.dim(`PR URL: ${prUrl}`));
      log(chalk.dim(`Model: ${model}`));
      if (reasoningEffort) {
        log(chalk.dim(`Reasoning Effort: ${reasoningEffort}`));
      }
      log();

      streamLog(chalk.dim("▶ Setting up workspace..."));
      const { review, metricsFooter, renderContext } = await reviewPr({
        prUrl,
        model,
        reasoningEffort,
        customPrompt: prompt,
        promptFile,
        cleanup: !workspace,
        workspaceDir: workspace,
        includeMetricsFooter: post,
        onEvent: handleEvent,
      });
      const reviewText = renderMarkdown(review, renderContext);

      streamLog(chalk.green("✔ Review complete!"));

      if (post) {
        log(chalk.cyan("\nPosting review to PR/MR..."));

        const result = await postReviewComment({
          prUrl,
          reviewText,
          model,
          metricsFooter,
        });

        if (result.success) {
          log(chalk.bold.green("Review posted successfully!"));
          log(chalk.dim(`  ${platform === "github" ? "PR" : "MR"}: ${prUrl}`));
        } else {
          log(chalk.bold.red(`Failed to post review: ${result.error}`));
          log(chalk.yellow("\nReview output:\n"));
          console.log(reviewText);
        }
      } else {
        log(chalk.bold.green("Review Complete\n"));
        console.log(reviewText);
        log(
          chalk.dim(
            "\nTip: Use --post to automatically post this review to the PR/MR",
          ),
        );
      }
    } catch (err) {
      streamLog(chalk.red("✗ Review failed"));
      console.error(
        chalk.bold.red(`\nError: ${err instanceof Error ? err.message : err}`),
      );
      if (verbose && err instanceof Error && err.stack) {
        console.error(chalk.dim(err.stack));
      }
      process.exit(1);
    }
  });

// --- Learn subcommand (hodor learn <pr-url>) ---
program
  .command("learn")
  .description(
    "Learn from human feedback on a Hodor review.\n\n" +
      "Fetches comments posted after Hodor's review on a PR/MR,\n" +
      "extracts durable learnings from the feedback, and saves them\n" +
      "to the knowledge base for improved future reviews.",
  )
  .argument("<pr-url>", "URL of the GitHub PR or GitLab MR to learn from")
  .option(
    "--model <model>",
    "LLM model for feedback extraction",
    "anthropic/claude-sonnet-4-5-20250929",
  )
  .option("-v, --verbose", "Enable verbose logging", false)
  .option(
    "--dry-run",
    "Show what would be extracted without saving to the knowledge base",
    false,
  )
  .action(async (prUrl: string, cmdOpts: Record<string, unknown>) => {
    const verbose = cmdOpts.verbose as boolean;
    const dryRun = cmdOpts.dryRun as boolean;
    const model = cmdOpts.model as string;

    if (verbose) setLogLevel("debug");

    const log = console.log;

    try {
      const platform = detectPlatform(prUrl);
      const parsed = parsePrUrl(prUrl);
      const targetRepo = `${parsed.owner}/${parsed.repo}`;

      log(`\n${chalk.bold.cyan("Hodor - Feedback Learning")}`);
      log(chalk.dim(`Platform: ${platform.toUpperCase()}`));
      log(chalk.dim(`PR URL: ${prUrl}`));
      log(chalk.dim(`Model: ${model}`));
      if (dryRun)
        log(chalk.yellow("Dry run mode — no writes to knowledge base"));
      log();

      // Fetch feedback context
      log(chalk.dim("▶ Fetching PR comments..."));
      const { fetchFeedbackContext, runFeedbackExtraction } =
        await import("./feedback.js");

      const feedbackCtx = await fetchFeedbackContext(prUrl);
      if (!feedbackCtx) {
        log(chalk.yellow("No Hodor review comment found on this PR/MR."));
        log(
          chalk.dim(
            '  Hodor identifies its reviews by the footer: "Review generated by Hodor"',
          ),
        );
        process.exit(0);
      }

      log(
        chalk.dim(
          `  Found Hodor review posted at ${feedbackCtx.hodorReview.created_at}`,
        ),
      );
      log(
        chalk.dim(
          `  Found ${feedbackCtx.feedbackComments.length} feedback comment(s) after the review`,
        ),
      );
      if (feedbackCtx.preReviewComments.length > 0) {
        log(
          chalk.dim(
            `  Found ${feedbackCtx.preReviewComments.length} pre-review comment(s) (included as context)`,
          ),
        );
      }

      if (feedbackCtx.feedbackComments.length === 0) {
        log(
          chalk.yellow(
            "\nNo feedback comments found after Hodor's review. Nothing to learn.",
          ),
        );
        process.exit(0);
      }

      log(chalk.dim("\n▶ Running feedback extraction..."));

      const { getKnowledgeBaseConfig, checkKnowledgeBaseHealth } =
        await import("./knowledge.js");

      const kbConfig = getKnowledgeBaseConfig();

      if (!dryRun) {
        if (!kbConfig.enabled) {
          log(chalk.red("Knowledge base is not enabled."));
          log(
            chalk.dim(
              "  Set HODOR_KB_ENABLED=true, HODOR_QDRANT_URL, and HODOR_QDRANT_API_KEY",
            ),
          );
          process.exit(1);
        }

        const health = await checkKnowledgeBaseHealth(kbConfig);
        if (!health.ok) {
          log(
            chalk.red(`Knowledge base health check failed: ${health.reason}`),
          );
          process.exit(1);
        }
        if (!health.writable) {
          log(
            chalk.red(
              "Knowledge base is not writable. Set HODOR_KB_WRITE_ENABLED=true",
            ),
          );
          process.exit(1);
        }
      }

      const result = await runFeedbackExtraction({
        config: kbConfig,
        targetRepo,
        prUrl,
        model,
        feedbackContext: feedbackCtx,
        dryRun,
      });

      log();
      if (result.extracted === 0) {
        log(chalk.yellow("No learnings could be extracted from the feedback."));
      } else {
        log(chalk.bold.green("Feedback extraction complete:"));
        log(chalk.dim(`  Candidates extracted: ${result.extracted}`));
        if (dryRun) {
          log(chalk.dim(`  Would save: ${result.saved}`));
          log(chalk.dim(`  Would reject: ${result.rejected}`));
        } else {
          log(chalk.dim(`  Saved (new): ${result.saved}`));
          log(chalk.dim(`  Updated (merged): ${result.updated}`));
          log(chalk.dim(`  Rejected: ${result.rejected}`));
        }
      }

      if (result.errors.length > 0) {
        log(chalk.yellow(`\n  Errors: ${result.errors.length}`));
        for (const err of result.errors) {
          log(chalk.dim(`    - ${err}`));
        }
      }

      if (result.llmMetrics) {
        log(
          chalk.dim(
            `\n  LLM tokens: ${result.llmMetrics.totalTokens} (${result.llmMetrics.durationSeconds}s)`,
          ),
        );
        if (result.llmMetrics.cost > 0) {
          log(chalk.dim(`  LLM cost: $${result.llmMetrics.cost.toFixed(4)}`));
        }
      }

      if (result.learnings.length > 0) {
        const feedbackFooter = formatKnowledgeExtractionMarkdown({
          ...result,
          attempted: true,
        });

        const feedbackResult = await postFeedbackComment({
          prUrl,
          feedbackText: feedbackFooter,
          model,
        });

        if (feedbackResult.success) {
          log(chalk.bold.green("Review posted successfully!"));
          log(chalk.dim(`  ${platform === "github" ? "PR" : "MR"}: ${prUrl}`));
        } else {
          log(chalk.bold.red(`Failed to post review: ${feedbackResult.error}`));
          log(chalk.yellow("\nReview output:\n"));
          console.log(feedbackFooter);
        }
      }
    } catch (err) {
      log(chalk.red("✗ Feedback learning failed"));
      console.error(
        chalk.bold.red(`\nError: ${err instanceof Error ? err.message : err}`),
      );
      if (verbose && err instanceof Error && err.stack) {
        console.error(chalk.dim(err.stack));
      }
      process.exit(1);
    }
  });

program.parse();
