import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCheckRun,
  GitHubCheckRunProgress,
  updateCheckRun,
} from "../src/github-checks.js";

function mockFetch(ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 201 : 500,
    statusText: ok ? "Created" : "Error",
    json: async () => ({}),
    text: async () => "",
  });
}

describe("github-checks helper", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("createCheckRun POSTs an in_progress check run and returns id", async () => {
    const fetchMock = mockFetch(true);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: "Created",
      json: async () => ({ id: 123 }),
      text: async () => "",
    });

    const id = await createCheckRun({
      owner: "acme",
      repo: "hodor",
      headSha: "deadbeef",
      name: "Hodor review",
      token: "ghs_xxx",
      summary: "Analyzing PR…",
      detailsUrl: "https://example.com/run/1",
    });

    expect(id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/acme/hodor/check-runs");
    expect(init.method).toBe("POST");

    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.name).toBe("Hodor review");
    expect(body.head_sha).toBe("deadbeef");
    expect(body.status).toBe("in_progress");
    expect(body.details_url).toBe("https://example.com/run/1");
  });

  it("updateCheckRun PATCHes status and conclusion", async () => {
    const fetchMock = mockFetch(true);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await updateCheckRun({
      owner: "acme",
      repo: "hodor",
      checkRunId: 10,
      token: "ghs_xxx",
      status: "completed",
      conclusion: "success",
      title: "Hodor review",
      summary: "Done.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/acme/hodor/check-runs/10",
    );
    expect(init.method).toBe("PATCH");

    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.status).toBe("completed");
    expect(body.conclusion).toBe("success");
    expect(body.output.summary).toBe("Done.");
  });

  it("GitHubCheckRunProgress throttles repeated stage updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z").valueOf());

    const fetchMock = mockFetch(true);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const progress = new GitHubCheckRunProgress({
      owner: "acme",
      repo: "hodor",
      token: "ghs_xxx",
      checkRunId: 1,
      title: "Hodor review",
      throttleMs: 5000,
    });

    await progress.setStage("stage-a", "Summary A");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same stage shortly after should not trigger another update.
    await progress.setStage("stage-a", "Summary A2");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4000);
    await progress.setStage("stage-a", "Summary A3");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await progress.setStage("stage-a", "Summary A4");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await progress.complete("success", "All good.");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [, init] = fetchMock.mock.calls[2]!;
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.status).toBe("completed");
    expect(body.conclusion).toBe("success");

    vi.useRealTimers();
  });
});

