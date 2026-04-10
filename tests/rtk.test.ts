import { describe, expect, it } from "vitest";
import { isRtkCompatibleCommand } from "../src/rtk.js";

describe("isRtkCompatibleCommand", () => {
  it("returns true for direct supported commands", () => {
    expect(isRtkCompatibleCommand("git --no-pager diff origin/main...HEAD")).toBe(
      true,
    );
    expect(isRtkCompatibleCommand("gh pr view 123")).toBe(true);
  });

  it("returns true for commands prefixed with cd and &&", () => {
    expect(
      isRtkCompatibleCommand("cd /repo/workspace && git --no-pager diff HEAD~1"),
    ).toBe(true);
  });

  it("returns true when env vars are set before the command", () => {
    expect(
      isRtkCompatibleCommand(
        "cd /repo/workspace && GIT_PAGER=cat git --no-pager diff --name-only",
      ),
    ).toBe(true);
  });

  it("returns false for shell builtins and unknown commands", () => {
    expect(isRtkCompatibleCommand("export GIT_PAGER=cat")).toBe(false);
    expect(isRtkCompatibleCommand("inspect diff")).toBe(false);
  });
});
