import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRtkCompatibleCommand } from "../rtk";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  // `execFile` does NOT run through a shell, so the "file" argument must be
  // an actual executable path (no spaces like "rtk gh").
  //
  // RTK is invoked as: `rtk <subcommand> <...originalArgs>`
  // If the caller already asked for `rtk ...`, don't double-wrap.
  const shouldWrapWithRtk = cmd !== "rtk" && isRtkCompatibleCommand(cmd);

  // Allow `cmd` to contain extra flags by splitting it into:
  // - RTK subcommand (first token)
  // - additional tokens (middle tokens)
  // - followed by the provided `args`
  const cmdParts = cmd.trim().split(/\s+/);
  const rtkSubcommand = cmdParts[0];
  const cmdRemainderArgs = cmdParts.slice(1);

  const { stdout, stderr } = shouldWrapWithRtk
    ? await execFileAsync("rtk", [rtkSubcommand, ...cmdRemainderArgs, ...args], {
        cwd: opts?.cwd,
        env: opts?.env ?? process.env,
        maxBuffer: 50 * 1024 * 1024, // 50MB
      })
    : await execFileAsync(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env ?? process.env,
    maxBuffer: 50 * 1024 * 1024, // 50MB
  });
  return { stdout, stderr };
}

export async function execJson<T = Record<string, unknown>>(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<T> {
  const { stdout } = await exec(cmd, args, opts);
  return JSON.parse(stdout.trim()) as T;
}
