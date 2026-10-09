const FILE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_TRACKED_FILES = 100;

let touched = new Set<string>();

export function resetTouchedFiles(): void {
  touched = new Set();
}

export function noteTouchedFile(path: string | undefined): void {
  const normalized = normalizePath(path);
  if (!normalized) return;
  touched.add(normalized);
}

export function touchedFiles(): string[] {
  return [...touched].sort().slice(0, MAX_TRACKED_FILES);
}

export function pathsFromToolCall(toolName: string, args: unknown): string[] {
  const obj = asRecord(args);
  if (!obj) return [];

  if (FILE_TOOLS.has(toolName)) {
    const path = stringField(obj, "path") ?? stringField(obj, "file_path");
    return path ? [path] : [];
  }

  if (toolName === "bash") {
    const command = stringField(obj, "command");
    return command ? pathsFromBash(command) : [];
  }

  return [];
}

function pathsFromBash(command: string): string[] {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const paths: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) continue;
    if (token.includes("://")) continue;
    if (token === "&&" || token === "||" || token === "|" || token === ";") {
      continue;
    }
    if (token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token)) {
      paths.push(token);
    }
  }
  return paths;
}

function normalizePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (!trimmed || trimmed === ".") return undefined;
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
