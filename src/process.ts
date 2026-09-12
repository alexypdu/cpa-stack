import { spawn } from "node:child_process";

import { signalExitStatuses } from "./signals.ts";

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        status: code ?? signalExitStatuses[signal as keyof typeof signalExitStatuses] ?? 1,
        stdout,
        stderr,
      });
    });

    child.stdin.end(options.input);
  });
}
