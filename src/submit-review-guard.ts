import { logger } from "./utils/logger.js";

/** Minimal session surface used to enforce submit_review before exiting. */
export interface SubmitReviewSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName(toolNames: string[]): void;
  getLastAssistantText(): string | undefined;
  state: { error?: string; messages?: unknown[] };
}

export const SUBMIT_REVIEW_FOLLOWUP_PROMPT =
  "Your analysis is complete but you have not submitted the review. " +
  "Call `submit_review` exactly once now with your final structured review payload. " +
  "Do not run bash, read, grep, find, ls, or query_knowledge_base. " +
  "Do not output the review as normal assistant text.";

export const SUBMIT_REVIEW_RETRY_PROMPT =
  "Your previous `submit_review` call was rejected or incomplete. " +
  "Fix the payload using the tool error feedback above and call `submit_review` exactly once. " +
  "Do not run other tools.";

const DEFAULT_SUBMIT_REVIEW_MAX_RETRIES = 2;

export function resolveSubmitReviewMaxRetries(): number {
  const raw = process.env.HODOR_SUBMIT_REVIEW_MAX_RETRIES?.trim();
  if (!raw) return DEFAULT_SUBMIT_REVIEW_MAX_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SUBMIT_REVIEW_MAX_RETRIES;
  }
  return parsed;
}

export function buildSubmitReviewFollowupPrompt(submitReviewCalls: number): string {
  return submitReviewCalls > 0
    ? SUBMIT_REVIEW_RETRY_PROMPT
    : SUBMIT_REVIEW_FOLLOWUP_PROMPT;
}

export function getAgentSessionError(session: SubmitReviewSession): string | undefined {
  return session.state?.error;
}

export async function runUntilSubmitReview(opts: {
  session: SubmitReviewSession;
  initialPrompt: string;
  isSubmitted: () => boolean;
  getSubmitReviewCalls: () => number;
  maxRetries?: number;
}): Promise<void> {
  const maxRetries = opts.maxRetries ?? resolveSubmitReviewMaxRetries();

  await opts.session.prompt(opts.initialPrompt);
  assertNoAgentError(opts.session);

  let attempt = 0;
  while (!opts.isSubmitted() && attempt < maxRetries) {
    attempt++;
    logger.warn(
      `Agent did not call submit_review; sending follow-up (${attempt}/${maxRetries})`,
    );
    opts.session.setActiveToolsByName(["submit_review"]);
    await opts.session.prompt(
      buildSubmitReviewFollowupPrompt(opts.getSubmitReviewCalls()),
    );
    assertNoAgentError(opts.session);
  }
}

function assertNoAgentError(session: SubmitReviewSession): void {
  const agentError = getAgentSessionError(session);
  if (agentError) {
    throw new Error(`LLM request failed: ${agentError}`);
  }
}

export function logMissingSubmitReviewDebug(session: SubmitReviewSession): void {
  const rawText = session.getLastAssistantText() ?? "";
  if (rawText) {
    logger.debug(
      `Last assistant text without submit_review (first 500 chars): ${rawText.slice(0, 500)}`,
    );
    return;
  }

  const messages = session.state?.messages;
  const lastMsg = messages?.[messages.length - 1];
  logger.debug(`Last message: ${JSON.stringify(lastMsg)?.slice(0, 500)}`);
}

export function missingSubmitReviewError(submitReviewCalls: number): Error {
  if (submitReviewCalls > 0) {
    return new Error(
      "Agent called submit_review but did not provide a valid review payload",
    );
  }
  return new Error("Agent did not call submit_review");
}
