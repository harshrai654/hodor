import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { exec } from "./utils/exec.js";

const KB_INDEX_VERSION = 1;
const KB_ENTRIES_DIR = "entries";
const KB_INDEX_DIR = "indexes";

export const QUERY_KNOWLEDGE_BASE_SCHEMA = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
    symbols: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export const SAVE_KNOWLEDGE_BASE_SCHEMA = Type.Object(
  {
    learning: Type.String({ minLength: 1 }),
    category: Type.Union([
      Type.Literal("architecture"),
      Type.Literal("coding_pattern"),
      Type.Literal("service_call_chain"),
      Type.Literal("fundamental_design"),
    ]),
    evidence: Type.String({ minLength: 1 }),
    stability: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ]),
    scope_tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
    symbols: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
    source_pr: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export interface KnowledgeBaseConfig {
  enabled: boolean;
  repo?: string;
  branch: string;
  localPath: string;
  pushOnSave: boolean;
  writeEnabled: boolean;
  defaultMaxResults: number;
}

export interface KnowledgeBaseHealth {
  ok: boolean;
  branchExists: boolean;
  writable: boolean;
  reason?: string;
}

export interface SaveKnowledgeInput {
  learning: string;
  category: "architecture" | "coding_pattern" | "service_call_chain" | "fundamental_design";
  evidence: string;
  stability: "low" | "medium" | "high";
  scope_tags: string[];
  paths?: string[];
  symbols?: string[];
  source_pr?: string;
}

export interface QueryKnowledgeInput {
  query: string;
  paths?: string[];
  symbols?: string[];
  max_results?: number;
}

export interface KnowledgeEntry {
  id: string;
  targetRepo: string;
  learning: string;
  category: SaveKnowledgeInput["category"];
  evidence: string;
  stability: SaveKnowledgeInput["stability"];
  scopeTags: string[];
  paths: string[];
  symbols: string[];
  sourcePr: string | null;
  createdAt: string;
  updatedAt: string;
  observations: number;
  fingerprint: string;
}

interface KnowledgeIndex {
  version: number;
  updatedAt: string;
  totalEntries: number;
  byTag: Record<string, string[]>;
  byPath: Record<string, string[]>;
  bySymbol: Record<string, string[]>;
}

export interface KnowledgeQueryMatch {
  id: string;
  learning: string;
  category: KnowledgeEntry["category"];
  evidence: string;
  stability: KnowledgeEntry["stability"];
  scopeTags: string[];
  paths: string[];
  symbols: string[];
  sourcePr: string | null;
  confidence: number;
}

export interface QueryKnowledgeResult {
  ok: boolean;
  reason?: string;
  matches: KnowledgeQueryMatch[];
}

export interface SaveKnowledgeResult {
  ok: boolean;
  status: "disabled" | "rejected" | "saved" | "updated";
  reason?: string;
  entryId?: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return value.toLowerCase() === "1" || value.toLowerCase() === "true";
}

function normalizeRepoId(targetRepo: string): string {
  return targetRepo.trim().toLowerCase();
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function sanitizeRepoForPath(targetRepo: string): string {
  return normalizeRepoId(targetRepo).replace(/[^a-z0-9._-]+/g, "__");
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

function scoreEntry(entry: KnowledgeEntry, queryTokens: Set<string>, scopeBoost: number): number {
  const corpus = tokenize(
    `${entry.learning} ${entry.evidence} ${entry.scopeTags.join(" ")} ${entry.paths.join(" ")} ${entry.symbols.join(" ")}`,
  );
  let tokenHits = 0;
  for (const token of queryTokens) {
    if (corpus.has(token)) tokenHits++;
  }
  const queryMatchScore = queryTokens.size === 0 ? 0 : tokenHits / queryTokens.size;
  const stabilityScore = entry.stability === "high" ? 1 : entry.stability === "medium" ? 0.7 : 0.3;
  const recencyDays = (Date.now() - Date.parse(entry.updatedAt)) / (24 * 60 * 60 * 1000);
  const recencyScore = recencyDays <= 30 ? 1 : recencyDays <= 90 ? 0.7 : 0.4;
  const score = queryMatchScore * 0.55 + stabilityScore * 0.25 + recencyScore * 0.1 + scopeBoost * 0.1;
  return Number(score.toFixed(4));
}

function isHighSignalCandidate(input: SaveKnowledgeInput): { accepted: boolean; reason?: string } {
  if (input.stability === "low") {
    return { accepted: false, reason: "stability must be medium or high" };
  }
  if (input.learning.trim().length < 40) {
    return { accepted: false, reason: "learning is too short for durable reuse" };
  }
  if (input.evidence.trim().length < 30) {
    return { accepted: false, reason: "evidence is too short" };
  }
  const lowercaseLearning = input.learning.toLowerCase();
  if (
    lowercaseLearning.includes("typo") ||
    lowercaseLearning.includes("rename only") ||
    lowercaseLearning.includes("formatting") ||
    lowercaseLearning.includes("temporary")
  ) {
    return { accepted: false, reason: "learning appears incidental or non-durable" };
  }
  return { accepted: true };
}

function buildFingerprint(targetRepo: string, input: SaveKnowledgeInput): string {
  const canonical = {
    repo: normalizeRepoId(targetRepo),
    category: input.category,
    learning: input.learning.trim().toLowerCase(),
    scope_tags: normalizeList(input.scope_tags).sort(),
    paths: normalizeList(input.paths).sort(),
    symbols: normalizeList(input.symbols).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24);
}

function buildEntryId(targetRepo: string, fingerprint: string): string {
  const ns = createHash("sha256").update(normalizeRepoId(targetRepo)).digest("hex").slice(0, 10);
  return `kb_${ns}_${fingerprint}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readEntries(entriesPath: string): Promise<KnowledgeEntry[]> {
  const exists = await fileExists(entriesPath);
  if (!exists) return [];
  const content = await readFile(entriesPath, "utf8");
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as KnowledgeEntry);
}

function buildIndex(entries: KnowledgeEntry[]): KnowledgeIndex {
  const byTag: Record<string, string[]> = {};
  const byPath: Record<string, string[]> = {};
  const bySymbol: Record<string, string[]> = {};
  for (const entry of entries) {
    for (const tag of entry.scopeTags) {
      byTag[tag] ??= [];
      byTag[tag].push(entry.id);
    }
    for (const path of entry.paths) {
      byPath[path] ??= [];
      byPath[path].push(entry.id);
    }
    for (const symbol of entry.symbols) {
      bySymbol[symbol] ??= [];
      bySymbol[symbol].push(entry.id);
    }
  }
  return {
    version: KB_INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    totalEntries: entries.length,
    byTag,
    byPath,
    bySymbol,
  };
}

async function writeEntries(entriesPath: string, entries: KnowledgeEntry[]): Promise<void> {
  const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(entriesPath, jsonl ? `${jsonl}\n` : "", "utf8");
}

async function writeIndex(indexPath: string, index: KnowledgeIndex): Promise<void> {
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function resolveRepoCloneUrl(repo: string): string {
  if (repo.includes("://")) return repo;
  const token = process.env.HODOR_KB_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}

function isMissingBranchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("couldn't find remote ref") ||
    message.includes("pathspec") ||
    message.includes("did not match any file") ||
    message.includes("unknown revision")
  );
}

function resolveKnowledgeLocalPath(): string {
  const configuredPath = process.env.HODOR_KB_LOCAL_PATH;
  if (!configuredPath) {
    return join(homedir(), ".hodor", "knowledge-base");
  }
  if (isAbsolute(configuredPath)) return configuredPath;
  return resolve(process.cwd(), configuredPath);
}

export function getKnowledgeBaseConfig(): KnowledgeBaseConfig {
  const repo = process.env.HODOR_KB_REPO?.trim();
  const branch = process.env.HODOR_KB_BRANCH?.trim() || "main";
  const localPath = resolveKnowledgeLocalPath();
  const pushOnSave = parseBoolean(process.env.HODOR_KB_PUSH_ON_SAVE, false);
  const writeEnabled = parseBoolean(process.env.HODOR_KB_WRITE_ENABLED, true);
  const defaultMaxResultsRaw = Number.parseInt(process.env.HODOR_KB_MAX_RESULTS ?? "", 10);
  const defaultMaxResults = Number.isFinite(defaultMaxResultsRaw) && defaultMaxResultsRaw > 0
    ? Math.min(defaultMaxResultsRaw, 20)
    : 6;
  return {
    enabled: Boolean(repo),
    repo,
    branch,
    localPath,
    pushOnSave,
    writeEnabled,
    defaultMaxResults,
  };
}

export async function checkKnowledgeBaseHealth(
  config: KnowledgeBaseConfig,
): Promise<KnowledgeBaseHealth> {
  if (!config.enabled || !config.repo) {
    return { ok: false, branchExists: false, writable: false, reason: "HODOR_KB_REPO not configured" };
  }

  if (parseBoolean(process.env.HODOR_KB_SKIP_SYNC, false)) {
    return { ok: true, branchExists: true, writable: config.writeEnabled };
  }

  const remoteUrl = resolveRepoCloneUrl(config.repo);

  try {
    await exec("git", ["ls-remote", remoteUrl]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      branchExists: false,
      writable: false,
      reason: `KB repo is not reachable/authenticated: ${message}`,
    };
  }

  let branchExists = true;
  try {
    await exec("git", ["ls-remote", "--exit-code", "--heads", remoteUrl, config.branch]);
  } catch {
    branchExists = false;
  }

  if (!branchExists) {
    if (config.writeEnabled && config.pushOnSave) {
      return {
        ok: true,
        branchExists: false,
        writable: true,
        reason: `KB branch '${config.branch}' missing; it will be bootstrapped on first save.`,
      };
    }
    return {
      ok: false,
      branchExists: false,
      writable: false,
      reason: `KB branch '${config.branch}' does not exist. Enable push-on-save to bootstrap it, or create the branch manually.`,
    };
  }

  return { ok: true, branchExists: true, writable: config.writeEnabled };
}

async function bootstrapKnowledgeBranch(clonePath: string, branch: string): Promise<void> {
  await exec("git", ["checkout", "-B", branch], { cwd: clonePath });
  await mkdir(join(clonePath, KB_ENTRIES_DIR), { recursive: true });
  await mkdir(join(clonePath, KB_INDEX_DIR), { recursive: true });
  await writeFile(
    join(clonePath, "README.md"),
    "# Hodor Knowledge Base\n\nPersistent review learnings stored by Hodor.\n",
    "utf8",
  );
  await writeFile(join(clonePath, KB_ENTRIES_DIR, ".gitkeep"), "", "utf8");
  await writeFile(join(clonePath, KB_INDEX_DIR, ".gitkeep"), "", "utf8");
  await exec("git", ["add", "README.md", join(KB_ENTRIES_DIR, ".gitkeep"), join(KB_INDEX_DIR, ".gitkeep")], {
    cwd: clonePath,
  });
  await exec("git", ["commit", "-m", "knowledge: bootstrap storage"], { cwd: clonePath });
  await exec("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd: clonePath });
}

async function syncKnowledgeRepo(config: KnowledgeBaseConfig): Promise<string> {
  if (!config.enabled || !config.repo) {
    throw new Error("Knowledge base is disabled. Set HODOR_KB_REPO to enable it.");
  }

  const clonePath = config.localPath;
  const skipSync = parseBoolean(process.env.HODOR_KB_SKIP_SYNC, false);
  if (skipSync) {
    await mkdir(join(clonePath, KB_ENTRIES_DIR), { recursive: true });
    await mkdir(join(clonePath, KB_INDEX_DIR), { recursive: true });
    return clonePath;
  }

  await mkdir(dirname(clonePath), { recursive: true });
  const hasGit = await fileExists(join(clonePath, ".git", "HEAD"));
  if (!hasGit) {
    await mkdir(dirname(clonePath), { recursive: true });
    try {
      await exec("gh", ["repo", "clone", config.repo, clonePath]);
    } catch {
      await exec("git", ["clone", resolveRepoCloneUrl(config.repo), clonePath]);
    }
  }

  try {
    await exec("git", ["fetch", "origin", config.branch], { cwd: clonePath });
    await exec("git", ["checkout", config.branch], { cwd: clonePath });
    await exec("git", ["pull", "--rebase", "origin", config.branch], { cwd: clonePath });
  } catch (err) {
    if (isMissingBranchError(err) && config.writeEnabled && config.pushOnSave) {
      await bootstrapKnowledgeBranch(clonePath, config.branch);
    } else if (isMissingBranchError(err)) {
      throw new Error(
        `Knowledge base branch '${config.branch}' is missing. Enable HODOR_KB_PUSH_ON_SAVE with write access, or create the branch manually.`,
      );
    } else {
      throw err;
    }
  }
  await mkdir(join(clonePath, KB_ENTRIES_DIR), { recursive: true });
  await mkdir(join(clonePath, KB_INDEX_DIR), { recursive: true });
  return clonePath;
}

function getTargetRepoPaths(clonePath: string, targetRepo: string): { entriesPath: string; indexPath: string } {
  const repoFile = sanitizeRepoForPath(targetRepo);
  return {
    entriesPath: join(clonePath, KB_ENTRIES_DIR, `${repoFile}.jsonl`),
    indexPath: join(clonePath, KB_INDEX_DIR, `${repoFile}.index.json`),
  };
}

function applyScopeFilter(entry: KnowledgeEntry, query: QueryKnowledgeInput): number {
  let boost = 0;
  const queryPaths = normalizeList(query.paths);
  const querySymbols = normalizeList(query.symbols);
  if (queryPaths.length > 0) {
    if (queryPaths.some((p) => entry.paths.includes(p))) boost += 1;
    else return -1;
  }
  if (querySymbols.length > 0) {
    if (querySymbols.some((s) => entry.symbols.includes(s))) boost += 1;
    else return -1;
  }
  return boost;
}

async function maybeCommitAndPush(
  clonePath: string,
  branch: string,
  repoSlug: string,
  relativePaths: string[],
): Promise<void> {
  const status = await exec("git", ["status", "--porcelain", ...relativePaths], { cwd: clonePath });
  if (status.stdout.trim().length === 0) return;

  await exec("git", ["add", ...relativePaths], { cwd: clonePath });

  const message = `knowledge: update ${repoSlug} learnings`;
  await exec("git", ["commit", "-m", message], { cwd: clonePath });
  await exec("git", ["push", "origin", `HEAD:${branch}`], { cwd: clonePath });
}

export async function queryKnowledgeBase(
  config: KnowledgeBaseConfig,
  targetRepo: string,
  query: QueryKnowledgeInput,
): Promise<QueryKnowledgeResult> {
  if (!config.enabled) {
    return { ok: false, reason: "Knowledge base disabled (missing HODOR_KB_REPO)", matches: [] };
  }
  const clonePath = await syncKnowledgeRepo(config);
  const { entriesPath } = getTargetRepoPaths(clonePath, targetRepo);
  const entries = await readEntries(entriesPath);
  if (entries.length === 0) {
    return { ok: true, matches: [] };
  }

  const queryTokens = tokenize(query.query);
  const ranked = entries
    .map((entry) => {
      const scopeBoost = applyScopeFilter(entry, query);
      if (scopeBoost < 0) return null;
      const confidence = scoreEntry(entry, queryTokens, scopeBoost);
      return { entry, confidence };
    })
    .filter((item): item is { entry: KnowledgeEntry; confidence: number } => item != null)
    .sort((a, b) => b.confidence - a.confidence || b.entry.updatedAt.localeCompare(a.entry.updatedAt));

  const limit = query.max_results ?? config.defaultMaxResults;
  const matches = ranked.slice(0, limit).map(({ entry, confidence }) => ({
    id: entry.id,
    learning: entry.learning,
    category: entry.category,
    evidence: entry.evidence,
    stability: entry.stability,
    scopeTags: entry.scopeTags,
    paths: entry.paths,
    symbols: entry.symbols,
    sourcePr: entry.sourcePr,
    confidence,
  }));

  return { ok: true, matches };
}

export async function saveKnowledgeBase(
  config: KnowledgeBaseConfig,
  targetRepo: string,
  input: SaveKnowledgeInput,
): Promise<SaveKnowledgeResult> {
  if (!config.enabled) {
    return { ok: false, status: "disabled", reason: "Knowledge base disabled (missing HODOR_KB_REPO)" };
  }
  if (!config.writeEnabled) {
    return { ok: false, status: "disabled", reason: "Knowledge base writes disabled by HODOR_KB_WRITE_ENABLED" };
  }

  const gate = isHighSignalCandidate(input);
  if (!gate.accepted) {
    return { ok: false, status: "rejected", reason: gate.reason };
  }

  const clonePath = await syncKnowledgeRepo(config);
  const repoSlug = normalizeRepoId(targetRepo);
  const { entriesPath, indexPath } = getTargetRepoPaths(clonePath, repoSlug);
  const entries = await readEntries(entriesPath);
  const now = new Date().toISOString();
  const fingerprint = buildFingerprint(repoSlug, input);
  const existing = entries.find((entry) => entry.fingerprint === fingerprint);

  let status: SaveKnowledgeResult["status"] = "saved";
  let entryId: string;
  if (existing) {
    existing.updatedAt = now;
    existing.observations += 1;
    if (input.source_pr) existing.sourcePr = input.source_pr;
    status = "updated";
    entryId = existing.id;
  } else {
    const id = buildEntryId(repoSlug, fingerprint);
    entryId = id;
    entries.push({
      id,
      targetRepo: repoSlug,
      learning: input.learning.trim(),
      category: input.category,
      evidence: input.evidence.trim(),
      stability: input.stability,
      scopeTags: normalizeList(input.scope_tags),
      paths: normalizeList(input.paths),
      symbols: normalizeList(input.symbols),
      sourcePr: input.source_pr ?? null,
      createdAt: now,
      updatedAt: now,
      observations: 1,
      fingerprint,
    });
  }

  const sortedEntries = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const index = buildIndex(sortedEntries);
  await writeEntries(entriesPath, sortedEntries);
  await writeIndex(indexPath, index);

  if (config.pushOnSave) {
    const entriesRel = join(KB_ENTRIES_DIR, basename(entriesPath));
    const indexRel = join(KB_INDEX_DIR, basename(indexPath));
    await maybeCommitAndPush(clonePath, config.branch, repoSlug, [entriesRel, indexRel]);
  }

  return { ok: true, status, entryId };
}
