import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import { OperationalError } from "./errors.ts";
import type { RepositoryPaths } from "./paths.ts";

export async function readClientApiKey(
  paths: RepositoryPaths,
  client?: string,
): Promise<string> {
  const variable =
    client === undefined
      ? "CPA_CLIENT_API_KEY"
      : `CPA_CLIENT_API_KEY_${client.toUpperCase().replaceAll("-", "_")}`;
  let source: string;
  try {
    source = await readFile(paths.environment, "utf8");
  } catch {
    throw new OperationalError(`cannot read ${paths.environment}`);
  }
  const environment = parseEnv(source);
  const value = environment[variable];
  if (value === undefined || value === "") {
    throw new OperationalError(
      `${variable} is not set in ${paths.environment}`,
    );
  }
  return value;
}
