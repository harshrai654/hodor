let requestedExit: number | null = null;

export function requestExit(code: number): void {
  requestedExit = code;
}

export function requestedExitCode(): number | null {
  return requestedExit;
}

export function resetRequestedExitForTests(): void {
  requestedExit = null;
}

export async function finishThenExit(deps: {
  finish: () => Promise<void>;
  exit: (code: number) => void;
  code: number | null;
}): Promise<void> {
  await deps.finish();
  if (deps.code) deps.exit(deps.code);
}
