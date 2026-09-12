import { stat } from "node:fs/promises";

import type { Operation } from "./cli.ts";
import { OperationalError } from "./errors.ts";
import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "./process.ts";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function runRequiredCommand(
  args: string[],
  options: CommandOptions,
  diagnostic: string,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runCommand("docker", args, options);
  } catch {
    throw new OperationalError(diagnostic);
  }
  if (result.status !== 0) {
    throw new OperationalError(diagnostic);
  }
  return result;
}

export const bounceOperation: Operation = async ({ lifecycle, paths }) => {
  if (!(await isFile(paths.compose))) {
    throw new OperationalError(`required file not found: ${paths.compose}`);
  }
  if (!(await isFile(paths.effective))) {
    throw new OperationalError(
      "effective config not found; run cpa-stack generate first",
    );
  }
  if (!(await isFile(paths.environment))) {
    throw new OperationalError(`required file not found: ${paths.environment}`);
  }

  let composeVersion;
  try {
    composeVersion = await runCommand("docker", ["compose", "version"], {
      cwd: paths.root,
      signal: lifecycle.abortController.signal,
    });
  } catch {
    throw new OperationalError("Docker with Compose is required");
  }
  if (composeVersion.status !== 0) {
    throw new OperationalError("Docker Compose is required");
  }

  const composeArgs = [
    "compose",
    "--project-directory",
    paths.root,
    "--env-file",
    paths.environment,
    "-f",
    paths.compose,
  ];
  const commandOptions = {
    cwd: paths.root,
    signal: lifecycle.abortController.signal,
  };

  await runRequiredCommand(
    [...composeArgs, "config", "--quiet"],
    commandOptions,
    "could not validate the CPA Stack configuration",
  );

  await runRequiredCommand(
    [
      ...composeArgs,
      "up",
      "-d",
      "--force-recreate",
      "cli-proxy-api",
      "cpa-usage-keeper",
    ],
    commandOptions,
    "could not recreate the CPA Stack",
  );

  const serviceStatus = await runRequiredCommand(
    [
      ...composeArgs,
      "ps",
      "--all",
      "--status",
      "exited",
      "--services",
      "cli-proxy-api",
      "cpa-usage-keeper",
    ],
    commandOptions,
    "could not inspect recreated service status",
  );
  const exitedServices = serviceStatus.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (exitedServices.length > 0) {
    throw new OperationalError(
      `service exited during startup: ${exitedServices.join(", ")}`,
    );
  }

  process.stdout.write(
    "Recreated CPA and Keeper; no immediate service exit was observed.\n",
  );
};
