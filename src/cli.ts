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
  .version("0.3.0")
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

    if (verbose) setLogLevel("debug");

    // Handle ultrathink
    if (ultrathink) {
      reasoningEffort = "high";
    }

    // Check platform and token availability
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

    console.log(
      `\n${chalk.bold.cyan("Hodor - AI Code Review Agent")}`,
    );
    console.log(chalk.dim(`Platform: ${platform.toUpperCase()}`));
    console.log(chalk.dim(`PR URL: ${prUrl}`));
    console.log(chalk.dim(`Model: ${model}`));
    if (reasoningEffort) {
      console.log(chalk.dim(`Reasoning Effort: ${reasoningEffort}`));
    }
    console.log();

    const spinner = ora("Setting up workspace...").start();
    const toolIcons: Record<string, string> = {
      bash: "terminal",
      read: "file",
      grep: "search",
      find: "find",
      ls: "ls",
    };

    function handleEvent(event: AgentProgressEvent): void {
      switch (event.type) {
        case "agent_start":
          spinner.text = "Agent started, analyzing PR...";
          break;
        case "turn_start":
          spinner.text = `Turn ${event.turnIndex ?? "?"} — thinking...`;
          break;
        case "thinking":
          spinner.text = `Turn ${event.turnIndex ?? "?"} — reasoning...`;
          break;
        case "tool_start": {
          const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
          const preview = event.toolArgs
            ? `: ${event.toolArgs.slice(0, 80)}${event.toolArgs.length > 80 ? "…" : ""}`
            : "";
          spinner.text = `[${icon}]${preview}`;
          break;
        }
        case "tool_end": {
          const status = event.isError ? chalk.red("✗") : chalk.green("✓");
          const icon = toolIcons[event.toolName ?? ""] ?? event.toolName;
          spinner.text = `[${icon}] ${status}`;
          break;
        }
        case "turn_end":
          spinner.text = `Turn ${event.turnIndex ?? "?"} complete`;
          break;
        case "agent_end":
          spinner.text = "Extracting review...";
          break;
      }
    }

    try {
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

      spinner.succeed("Review complete!");

      if (post) {
        console.log(chalk.cyan("\nPosting review to PR/MR..."));

        const result = await postReviewComment({
          prUrl,
          reviewText,
          model,
          metricsFooter,
        });

        if (result.success) {
          console.log(chalk.bold.green("Review posted successfully!"));
          console.log(chalk.dim(`  ${platform === "github" ? "PR" : "MR"}: ${prUrl}`));
        } else {
          console.log(
            chalk.bold.red(`Failed to post review: ${result.error}`),
          );
          console.log(chalk.yellow("\nReview output:\n"));
          console.log(reviewText);
        }
      } else {
        console.log(chalk.bold.green("Review Complete\n"));
        console.log(reviewText);
        if (!outputJson) {
          console.log(
            chalk.dim(
              "\nTip: Use --post to automatically post this review to the PR/MR",
            ),
          );
        }
      }
    } catch (err) {
      spinner.fail("Review failed");
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
