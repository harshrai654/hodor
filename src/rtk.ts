import { exec } from "./utils/exec";

let rtkAvailable: boolean | null = null;

export async function checkRtkAvailable(): Promise<boolean> {
  try {
    if (rtkAvailable === null) {
      await exec("rtk", ["--version"]);
      rtkAvailable = true;
    }
    return rtkAvailable;
  } catch {
    rtkAvailable = false;
    return false;
  }
}

function extractPrimaryCommandToken(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) {
    return "";
  }

  // Bash tool commands are often prefixed with "cd <workspace> &&".
  // Inspect the final segment to identify the actual executable command.
  const segments = trimmed
    .split("&&")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const candidate = segments.length > 0 ? segments[segments.length - 1] : trimmed;
  const tokens = candidate.split(/\s+/);

  for (const token of tokens) {
    // Skip leading env assignments: FOO=bar git diff ...
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return token;
  }

  return "";
}

export function isRtkCompatibleCommand(cmd: string): boolean {
  // RTK-supported commands that provide token savings
  // Based on: https://github.com/rtk-ai/rtk README
  const supportedPrefixes = [
    // Git
    "git",
    // GitHub CLI
    "gh",
    // Files (cat/head/tail are rewritten to rtk read, rg/grep to rtk grep)
    "cat",
    "head",
    "tail",
    "rg",
    "grep",
    "ls",
    "find",
    // Rust/Cargo
    "cargo",
    // Node/npm
    "npm",
    "pnpm",
    "npx",
    // Testing
    "vitest",
    "jest",
    "playwright",
    "pytest",
    "ruff",
    "go",
    "golangci-lint",
    "rake",
    "rspec",
    "rubocop",
    "bundle",
    // Lint/Build
    "tsc",
    "eslint",
    "biome",
    "prettier",
    "next",
    "prisma",
    // Python
    "pip",
    // Docker/K8s
    "docker",
    "kubectl",
    // Network
    "curl",
    "wget",
    // RTK native commands (if called directly)
    "rtk",
  ];

  // Shell builtins that should never be wrapped
  const shellBuiltins = [
    "cd",
    "export",
    "source",
    "alias",
    "echo",
    "printenv",
    "pwd",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "touch",
    "chmod",
    "chown",
    "kill",
    "ps",
    "env",
    "set",
    "unset",
    "eval",
    "exec",
    "trap",
    "wait",
    "jobs",
    "fg",
    "bg",
    "disown",
    "type",
    "which",
    "hash",
    "history",
    "help",
    "exit",
    "return",
    "break",
    "continue",
    "shift",
    "getopts",
    "ulimit",
    "umask",
    "times",
    "caller",
    "read",
    "mapfile",
    "readarray",
    "shopt",
    "builtin",
    "command",
    "enable",
    "logout",
  ];

  const commandToken = extractPrimaryCommandToken(cmd);
  if (!commandToken) {
    return false;
  }

  const shellBuiltinsSet = new Set(shellBuiltins);
  if (shellBuiltinsSet.has(commandToken)) {
    return false;
  }

  const supportedPrefixesSet = new Set(supportedPrefixes);
  return supportedPrefixesSet.has(commandToken);
}
