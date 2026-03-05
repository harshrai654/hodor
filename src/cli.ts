#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import "dotenv/config";

import { detectPlatform, postReviewComment, reviewPr } from "./agent.js";
import type { AgentProgressEvent } from "./agent.js";
import { setLogLevel } from "./utils/logger.js";

const program = new Command();

program
  .name("hodor")
  .description(
    "AI-powered code review agent for GitHub PRs and GitLab MRs.\n\n" +
      "Hodor uses an AI agent that clones the repository, checks out the PR branch,\n" +
      "and analyzes the code using tools (gh, git, glab) for metadata fetching and comment posting.",
  )
  .version("0.3.2")
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
  .option(
    "--post",
    "Post the review directly to the PR/MR as a comment",
    false,
  )
  .option(
    "--json",
    "Output structured JSON format instead of markdown",
    false,
  )
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
    const outputJson = cmdOpts.json as boolean;
    const model = cmdOpts.model as string;
    let reasoningEffort = cmdOpts.reasoningEffort as string | undefined;
    const prompt = cmdOpts.prompt as string | undefined;
    const promptFile = cmdOpts.promptFile as string | undefined;
    const workspace = cmdOpts.workspace as string | undefined;
    const ultrathink = cmdOpts.ultrathink as boolean;

    // Auto-detect CI environment
    const isCI = !!(process.env.CI || process.env.GITLAB_CI || process.env.GITHUB_ACTIONS);

    if (verbose) setLogLevel("debug");
    else if (isCI) setLogLevel("info");

    // Handle ultrathink
    if (ultrathink) {
      reasoningEffort = "high";
    }

    // Use stderr for all non-review output so --json stdout stays machine-readable
    const log = outputJson ? console.error : console.log;
    const logStream = outputJson ? process.stderr : process.stdout;

    const spinner = isCI ? null : ora({ stream: logStream });
    const toolIcons: Record<string, string> = {
      bash: "terminal",
      read: "file",
      grep: "search",
      find: "find",
      ls: "ls",
    };

    /** Write a plain log line to the output stream (used in CI instead of spinner) */
    function ciLog(msg: string): void {
      logStream.write(`${msg}\n`);
    }

    function handleEvent(event: AgentProgressEvent): void {
      if (isCI) {
        // Plain sequential log lines for CI — no ANSI cursor tricks
        switch (event.type) {
          case "agent_start":
            ciLog("▶ Agent started, analyzing PR...");
            break;
          case "turn_start":
            ciLog(`── Turn ${event.turnIndex ?? "?"} ──`);
            break;
          case "tool_start": {
            const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
            const preview = event.toolArgs
              ? ` ${event.toolArgs.slice(0, 120)}${event.toolArgs.length > 120 ? "…" : ""}`
              : "";
            ciLog(`  ▸ [${icon}]${preview}`);
            break;
          }
          case "tool_end": {
            const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
            const status = event.isError ? "✗" : "✓";
            ciLog(`  ${status} [${icon}]`);
            break;
          }
          case "agent_end":
            ciLog("▶ Extracting review...");
            break;
          // thinking, turn_end: skip in CI to reduce noise
        }
        return;
      }

      // Interactive terminal — use spinner
      switch (event.type) {
        case "agent_start":
          spinner!.text = "Agent started, analyzing PR...";
          break;
        case "turn_start":
          spinner!.text = `Turn ${event.turnIndex ?? "?"} — thinking...`;
          break;
        case "thinking":
          spinner!.text = `Turn ${event.turnIndex ?? "?"} — reasoning...`;
          break;
        case "tool_start": {
          const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
          const preview = event.toolArgs
            ? `: ${event.toolArgs.slice(0, 80)}${event.toolArgs.length > 80 ? "…" : ""}`
            : "";
          spinner!.text = `[${icon}]${preview}`;
          break;
        }
        case "tool_end": {
          const status = event.isError ? chalk.red("✗") : chalk.green("✓");
          const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
          spinner!.text = `[${icon}] ${status}`;
          break;
        }
        case "turn_end":
          spinner!.text = `Turn ${event.turnIndex ?? "?"} complete`;
          break;
        case "agent_end":
          spinner!.text = "Extracting review...";
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
          chalk.dim("  Set GITHUB_TOKEN environment variable or run: gh auth login\n"),
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

      log(
        `\n${chalk.bold.cyan("Hodor - AI Code Review Agent")}`,
      );
      log(chalk.dim(`Platform: ${platform.toUpperCase()}`));
      log(chalk.dim(`PR URL: ${prUrl}`));
      log(chalk.dim(`Model: ${model}`));
      if (reasoningEffort) {
        log(chalk.dim(`Reasoning Effort: ${reasoningEffort}`));
      }
      log();

      if (spinner) spinner.start("Setting up workspace...");
      else ciLog("▶ Setting up workspace...");
      const { reviewText, metricsFooter } = await reviewPr({
        prUrl,
        model,
        reasoningEffort,
        customPrompt: prompt,
        promptFile,
        cleanup: !workspace,
        workspaceDir: workspace,
        outputFormat: outputJson ? "json" : "markdown",
        includeMetricsFooter: post,
        onEvent: handleEvent,
      });

      if (spinner) spinner.succeed("Review complete!");
      else ciLog("✔ Review complete!");

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
          log(
            chalk.bold.red(`Failed to post review: ${result.error}`),
          );
          log(chalk.yellow("\nReview output:\n"));
          console.log(reviewText);
        }
      } else {
        if (!outputJson) {
          log(chalk.bold.green("Review Complete\n"));
        }
        // Review text always goes to stdout (the only stdout output in --json mode)
        console.log(reviewText);
        if (!outputJson) {
          log(
            chalk.dim(
              "\nTip: Use --post to automatically post this review to the PR/MR",
            ),
          );
        }
      }
    } catch (err) {
      if (spinner) spinner.fail("Review failed");
      else ciLog("✗ Review failed");
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
