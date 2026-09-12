import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import deepmerge from "deepmerge";
import { parseAllDocuments, stringify } from "yaml";

import type { Operation } from "./cli.ts";
import { OperationalError } from "./errors.ts";
import { runCommand } from "./process.ts";

async function requireFile(path: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) {
      return;
    }
  } catch {
    // Report all missing or unreadable inputs through the command boundary.
  }
  throw new OperationalError(`required file not found: ${path}`);
}

type ValuePath = Array<string | number>;

interface ParsedYaml {
  aliasPaths: ValuePath[];
  value: unknown;
}

class AliasValue {
  readonly value: unknown;

  constructor(value: unknown) {
    this.value = value;
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function findAliasPaths(value: unknown): ValuePath[] {
  const seen = new WeakSet<object>();
  const aliasPaths: ValuePath[] = [];

  function visitValue(current: unknown, path: ValuePath): void {
    if (!isObject(current)) {
      return;
    }
    if (seen.has(current)) {
      aliasPaths.push(path);
      return;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      current.forEach((nested, index) => visitValue(nested, [...path, index]));
      return;
    }
    for (const [key, nested] of Object.entries(current)) {
      visitValue(nested, [...path, key]);
    }
  }

  visitValue(value, []);
  return aliasPaths;
}

function parseSingleDocument(source: string, description: string): ParsedYaml {
  const documents = parseAllDocuments(source, { prettyErrors: false });
  const [document] = documents;
  if (documents.length !== 1) {
    throw new OperationalError(
      `${description} must contain exactly one YAML document`,
    );
  }
  if (document?.errors.some(({ code }) => code === "DUPLICATE_KEY") === true) {
    throw new OperationalError(
      `${description} contains duplicate mapping keys`,
    );
  }
  const unsupportedWarnings =
    document?.warnings.filter(({ code }) => code !== "TAG_RESOLVE_FAILED") ??
    [];
  if (
    document === undefined ||
    document.errors.length > 0 ||
    unsupportedWarnings.length > 0
  ) {
    throw new OperationalError(`${description} is not supported YAML`);
  }
  const value: unknown = document.toJS();
  return { aliasPaths: findAliasPaths(value), value };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function mapNestedValues(
  value: unknown,
  mapString: (value: string) => string,
): unknown {
  if (typeof value === "string") {
    return mapString(value);
  }
  if (Array.isArray(value)) {
    return value.map((nested) => mapNestedValues(nested, mapString));
  }
  if (isMapping(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        mapNestedValues(nested, mapString),
      ]),
    );
  }
  return value;
}

function markAliasValues(value: unknown, aliasPaths: ValuePath[]): unknown {
  const paths = new Set(aliasPaths.map((path) => JSON.stringify(path)));

  function visitValue(current: unknown, path: ValuePath): unknown {
    if (paths.has(JSON.stringify(path))) {
      return new AliasValue(current);
    }
    if (Array.isArray(current)) {
      return current.map((nested, index) =>
        visitValue(nested, [...path, index]),
      );
    }
    if (isMapping(current)) {
      return Object.fromEntries(
        Object.entries(current).map(([key, nested]) => [
          key,
          visitValue(nested, [...path, key]),
        ]),
      );
    }
    return current;
  }

  return visitValue(value, []);
}

function unwrapAliasValues(value: unknown): unknown {
  if (value instanceof AliasValue) {
    return unwrapAliasValues(value.value);
  }
  if (Array.isArray(value)) {
    return value.map(unwrapAliasValues);
  }
  if (isMapping(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        unwrapAliasValues(nested),
      ]),
    );
  }
  return value;
}

export const generate: Operation = async ({ lifecycle, paths }) => {
  for (const path of [paths.baseline, paths.override, paths.environment]) {
    await requireFile(path);
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

  const baselineSource = await readFile(paths.baseline, "utf8");
  const overrideSource = await readFile(paths.override, "utf8");
  const baseline = parseSingleDocument(baselineSource, "the upstream baseline");
  const override = parseSingleDocument(overrideSource, "the stack override");
  if (!isMapping(baseline.value) || !isMapping(override.value)) {
    throw new OperationalError("the CPA configuration layers must be mappings");
  }

  await mkdir(dirname(paths.effective), { recursive: true });
  const stagingDirectory = await mkdtemp(
    join(dirname(paths.effective), ".cpa-stack-generate-"),
  );
  lifecycle.trackTemporary(stagingDirectory);
  await chmod(stagingDirectory, 0o700);
  const composeInput = join(stagingDirectory, "compose.yml");
  const stagedEffective = join(stagingDirectory, "config.yaml");
  const stagedBackup = join(stagingDirectory, "config.yaml.backup");
  await writeFile(
    composeInput,
    stringify({ "x-cpa-stack-override": override.value, services: {} }),
    { mode: 0o600 },
  );

  const composeResult = await runCommand(
    "docker",
    [
      "compose",
      "--project-directory",
      paths.root,
      "--env-file",
      paths.environment,
      "-f",
      composeInput,
      "config",
    ],
    {
      cwd: paths.root,
      signal: lifecycle.abortController.signal,
    },
  );
  if (composeResult.status !== 0) {
    throw new OperationalError("could not interpolate the stack override");
  }

  const composeOutput = parseSingleDocument(
    composeResult.stdout,
    "the resolved Compose configuration",
  );
  if (!isMapping(composeOutput.value)) {
    throw new OperationalError(
      "the resolved Compose configuration is not a mapping",
    );
  }
  const resolvedOverride = mapNestedValues(
    composeOutput.value["x-cpa-stack-override"],
    (value) => value.replaceAll("$$", "$"),
  );
  if (!isMapping(resolvedOverride)) {
    throw new OperationalError("the resolved stack override must be a mapping");
  }

  const effective = deepmerge(
    markAliasValues(baseline.value, baseline.aliasPaths) as object,
    markAliasValues(resolvedOverride, override.aliasPaths) as object,
    {
      arrayMerge: (_destination, source) => source,
      isMergeableObject: (value) =>
        isObject(value) && !(value instanceof AliasValue),
    },
  );
  await writeFile(stagedEffective, stringify(unwrapAliasValues(effective)), {
    mode: 0o600,
  });
  await chmod(stagedEffective, 0o600);

  try {
    if ((await stat(paths.effective)).isFile()) {
      await copyFile(paths.effective, stagedBackup);
      await chmod(stagedBackup, 0o600);
      await rename(stagedBackup, paths.backup);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OperationalError(
        "could not preserve the existing configuration",
      );
    }
  }

  try {
    await rename(stagedEffective, paths.effective);
  } catch {
    throw new OperationalError("could not replace the effective configuration");
  }
  process.stdout.write("Generated cpa/config.yaml with mode 0600.\n");
};
