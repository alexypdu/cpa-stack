import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { isMap, isScalar, parseDocument } from "yaml";

import type { Operation } from "./cli.ts";
import { OperationalError } from "./errors.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { runCommand, type CommandResult } from "./process.ts";

const cpaRepository = "eceasy/cli-proxy-api";
const keeperRepository = "ghcr.io/willxup/cpa-usage-keeper";
const cpaReleaseUrl =
  "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const keeperReleaseUrl =
  "https://api.github.com/repos/Willxup/cpa-usage-keeper/releases/latest";
const githubHeaders = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2022-11-28",
];

interface CurrentImages {
  composeDocument: ReturnType<typeof parseDocument>;
  cpaImage: string;
  cpaTag: string;
  keeperImage: string;
  keeperTag: string;
}

interface SelectedRelease {
  tag: string;
  image: string;
  available: boolean;
}

function fail(message: string): never {
  throw new OperationalError(message);
}

async function requireFile(path: string): Promise<void> {
  try {
    const file = await stat(path);
    if (!file.isFile()) {
      fail(`required file not found: ${path}`);
    }
    await access(path, constants.R_OK);
  } catch (error) {
    if (error instanceof OperationalError) {
      throw error;
    }
    fail(`required file not found: ${path}`);
  }
}

async function requireExecutable(name: string, message: string): Promise<void> {
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  for (const pathEntry of pathEntries) {
    if (pathEntry.length === 0) {
      continue;
    }
    try {
      await access(join(pathEntry, name), constants.X_OK);
      return;
    } catch {
      // Continue searching PATH.
    }
  }
  fail(message);
}

async function command(
  executable: string,
  args: string[],
  root: string,
  lifecycle: Lifecycle,
): Promise<CommandResult> {
  try {
    return await runCommand(executable, args, {
      cwd: root,
      signal: lifecycle.abortController.signal,
    });
  } catch (error) {
    if (lifecycle.abortController.signal.aborted) {
      throw error;
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    fail(`could not run ${executable}${detail}`);
  }
}

async function ensureCleanDestinations(
  root: string,
  lifecycle: Lifecycle,
): Promise<void> {
  const conflicts: string[] = [];
  for (const path of ["docker-compose.yml", "cpa/config.yaml.example"]) {
    const worktree = await command(
      "git",
      ["diff", "--quiet", "--", path],
      root,
      lifecycle,
    );
    const index = await command(
      "git",
      ["diff", "--cached", "--quiet", "--", path],
      root,
      lifecycle,
    );
    if (worktree.status !== 0 || index.status !== 0) {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) {
    fail(
      `refusing to overwrite pre-existing changes to: ${conflicts.join(", ")}`,
    );
  }
}

function parseCurrentImages(source: string): CurrentImages {
  const composeDocument = parseDocument(source);
  if (composeDocument.errors.length > 0 || !isMap(composeDocument.contents)) {
    fail("docker-compose.yml is not valid YAML");
  }

  const cpaNode = composeDocument.getIn(
    ["services", "cli-proxy-api", "image"],
    true,
  );
  const keeperNode = composeDocument.getIn(
    ["services", "cpa-usage-keeper", "image"],
    true,
  );
  if (!isScalar(cpaNode) || typeof cpaNode.value !== "string") {
    fail("could not read the CPA image declaration");
  }
  if (!isScalar(keeperNode) || typeof keeperNode.value !== "string") {
    fail("could not read the Keeper image declaration");
  }

  const cpaPrefix = `${cpaRepository}:`;
  const keeperPrefix = `${keeperRepository}:`;
  if (!cpaNode.value.startsWith(cpaPrefix)) {
    fail("docker-compose.yml has an unexpected CPA image declaration");
  }
  if (!keeperNode.value.startsWith(keeperPrefix)) {
    fail("docker-compose.yml has an unexpected Keeper image declaration");
  }

  return {
    composeDocument,
    cpaImage: cpaNode.value,
    cpaTag: cpaNode.value.slice(cpaPrefix.length),
    keeperImage: keeperNode.value,
    keeperTag: keeperNode.value.slice(keeperPrefix.length),
  };
}

async function download(
  url: string,
  destination: string,
  description: string,
  root: string,
  lifecycle: Lifecycle,
): Promise<void> {
  const result = await command(
    "curl",
    ["-fsSL", ...githubHeaders, "-o", destination, url],
    root,
    lifecycle,
  );
  if (result.status !== 0) {
    fail(`could not download ${description}`);
  }
}

async function readReleaseTag(
  path: string,
  releaseName: "CPA" | "Keeper",
): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${releaseName} release metadata is malformed`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("draft" in value) ||
    typeof value.draft !== "boolean" ||
    !("prerelease" in value) ||
    typeof value.prerelease !== "boolean" ||
    !("tag_name" in value) ||
    typeof value.tag_name !== "string"
  ) {
    fail(`${releaseName} release metadata is malformed`);
  }
  if (value.draft) {
    fail(`${releaseName} latest release is a draft`);
  }
  if (value.prerelease) {
    fail(`${releaseName} latest release is a prerelease`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value.tag_name)) {
    fail(`${releaseName} release metadata has an invalid tag`);
  }
  return value.tag_name;
}

async function selectRelease(
  repository: string,
  tag: string,
  root: string,
  lifecycle: Lifecycle,
): Promise<SelectedRelease> {
  const image = `${repository}:${tag}`;
  const result = await command(
    "docker",
    ["manifest", "inspect", image],
    root,
    lifecycle,
  );
  return { tag, image, available: result.status === 0 };
}

function validateBaseline(source: Buffer, tag: string): void {
  if (source.length === 0) {
    fail(`the CPA ${tag} upstream baseline is empty`);
  }
  const document = parseDocument(source.toString("utf8"));
  if (document.errors.length > 0 || !isMap(document.contents)) {
    fail(`the CPA ${tag} upstream baseline is not a valid YAML mapping`);
  }
}

function updateComposeImages(
  current: CurrentImages,
  cpaImage: string,
  keeperImage: string,
): string {
  const cpaNode = current.composeDocument.getIn(
    ["services", "cli-proxy-api", "image"],
    true,
  );
  const keeperNode = current.composeDocument.getIn(
    ["services", "cpa-usage-keeper", "image"],
    true,
  );
  if (!isScalar(cpaNode) || !isScalar(keeperNode)) {
    fail("could not update the expected image declarations");
  }
  cpaNode.value = cpaImage;
  keeperNode.value = keeperImage;
  const stagedSource = current.composeDocument.toString();
  const staged = parseCurrentImages(stagedSource);
  if (staged.cpaImage !== cpaImage || staged.keeperImage !== keeperImage) {
    fail(
      "docker-compose.yml has an unexpected image declaration after staging",
    );
  }
  return stagedSource;
}

async function prepareTrackedArtifactReplacement(
  destination: string,
  staged: string,
  description: string,
  lifecycle: Lifecycle,
): Promise<{ disarm: () => void; replace: () => Promise<void> }> {
  const rollbackDirectory = await mkdtemp(
    join(dirname(destination), ".cpa-stack-rollback-"),
  );
  lifecycle.trackTemporary(rollbackDirectory);
  const rollback = join(rollbackDirectory, "original");
  try {
    await copyFile(destination, rollback);
  } catch {
    fail(`could not copy ${description} for rollback`);
  }
  let replacementStarted = false;
  const disarm = lifecycle.onFailure(async () => {
    if (replacementStarted) {
      await rm(destination, { force: true, recursive: true });
      await copyFile(rollback, destination);
      await chmod(destination, 0o644);
    }
  });
  return {
    disarm,
    replace: async () => {
      replacementStarted = true;
      try {
        await rename(staged, destination);
        await chmod(destination, 0o644);
      } catch {
        fail(`could not replace ${description}`);
      }
    },
  };
}

export const syncOperation: Operation = async ({ lifecycle, paths }) => {
  await requireExecutable("curl", "curl is required");
  await requireExecutable(
    "docker",
    "Docker is required to verify image availability",
  );
  await requireExecutable("git", "Git is required");
  await requireFile(paths.compose);
  await requireFile(paths.baseline);
  await ensureCleanDestinations(paths.root, lifecycle);

  const currentComposeSource = await readFile(paths.compose, "utf8");
  const current = parseCurrentImages(currentComposeSource);
  const currentBaseline = await readFile(paths.baseline);

  const metadataDirectory = await mkdtemp(join(tmpdir(), "cpa-stack-sync-"));
  lifecycle.trackTemporary(metadataDirectory);
  const cpaReleasePath = join(metadataDirectory, "cpa-release.json");
  const keeperReleasePath = join(metadataDirectory, "keeper-release.json");
  await download(
    cpaReleaseUrl,
    cpaReleasePath,
    "CPA release metadata",
    paths.root,
    lifecycle,
  );
  await download(
    keeperReleaseUrl,
    keeperReleasePath,
    "Keeper release metadata",
    paths.root,
    lifecycle,
  );
  const cpaTag = await readReleaseTag(cpaReleasePath, "CPA");
  const keeperTag = await readReleaseTag(keeperReleasePath, "Keeper");

  const selectedCpa = await selectRelease(
    cpaRepository,
    cpaTag,
    paths.root,
    lifecycle,
  );
  let selectedBaseline = currentBaseline;
  if (selectedCpa.available) {
    const baselineStageDirectory = await mkdtemp(
      join(dirname(paths.baseline), ".cpa-stack-sync-"),
    );
    lifecycle.trackTemporary(baselineStageDirectory);
    const downloadedBaseline = join(
      baselineStageDirectory,
      "config.yaml.example",
    );
    await download(
      `https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/${cpaTag}/config.example.yaml`,
      downloadedBaseline,
      `the CPA ${cpaTag} upstream baseline`,
      paths.root,
      lifecycle,
    );
    selectedBaseline = await readFile(downloadedBaseline);
    validateBaseline(selectedBaseline, cpaTag);
  }

  const selectedKeeper = await selectRelease(
    keeperRepository,
    keeperTag,
    paths.root,
    lifecycle,
  );
  const expectedCpaImage = selectedCpa.available
    ? selectedCpa.image
    : current.cpaImage;
  const expectedKeeperImage = selectedKeeper.available
    ? selectedKeeper.image
    : current.keeperImage;
  const cpaChanged = current.cpaImage !== expectedCpaImage;
  const keeperChanged = current.keeperImage !== expectedKeeperImage;
  const composeChanged = cpaChanged || keeperChanged;
  const baselineChanged = !currentBaseline.equals(selectedBaseline);

  let stagedCompose: string | undefined;
  let stagedBaseline: string | undefined;
  if (composeChanged) {
    const composeStageDirectory = await mkdtemp(
      join(dirname(paths.compose), ".cpa-stack-sync-"),
    );
    lifecycle.trackTemporary(composeStageDirectory);
    stagedCompose = join(composeStageDirectory, "docker-compose.yml");
    await writeFile(
      stagedCompose,
      updateComposeImages(current, expectedCpaImage, expectedKeeperImage),
      { mode: 0o644 },
    );
    await chmod(stagedCompose, 0o644);
  }
  if (baselineChanged) {
    const baselineStageDirectory = await mkdtemp(
      join(dirname(paths.baseline), ".cpa-stack-stage-"),
    );
    lifecycle.trackTemporary(baselineStageDirectory);
    stagedBaseline = join(baselineStageDirectory, "config.yaml.example");
    await writeFile(stagedBaseline, selectedBaseline, { mode: 0o644 });
    await chmod(stagedBaseline, 0o644);
  }

  await ensureCleanDestinations(paths.root, lifecycle);

  const replacements: Array<{
    disarm: () => void;
    replace: () => Promise<void>;
  }> = [];
  if (stagedCompose !== undefined) {
    replacements.push(
      await prepareTrackedArtifactReplacement(
        paths.compose,
        stagedCompose,
        "docker-compose.yml",
        lifecycle,
      ),
    );
  }
  if (stagedBaseline !== undefined) {
    replacements.push(
      await prepareTrackedArtifactReplacement(
        paths.baseline,
        stagedBaseline,
        "the upstream baseline",
        lifecycle,
      ),
    );
  }
  for (const replacement of replacements) {
    await replacement.replace();
  }

  if (!selectedCpa.available) {
    process.stdout.write(
      `CPA: selected ${cpaTag}, but its image is unavailable; kept ${current.cpaTag}.\n`,
    );
  } else if (cpaChanged) {
    process.stdout.write(`CPA: selected ${cpaTag} (updated).\n`);
  } else {
    process.stdout.write(`CPA: selected ${cpaTag} (unchanged).\n`);
  }
  if (!selectedKeeper.available) {
    process.stdout.write(
      `Keeper: selected ${keeperTag}, but its image is unavailable; kept ${current.keeperTag}.\n`,
    );
  } else if (keeperChanged) {
    process.stdout.write(`Keeper: selected ${keeperTag} (updated).\n`);
  } else {
    process.stdout.write(`Keeper: selected ${keeperTag} (unchanged).\n`);
  }
  process.stdout.write(
    baselineChanged
      ? "Upstream baseline: updated cpa/config.yaml.example.\n"
      : "Upstream baseline: unchanged.\n",
  );
  if (composeChanged) {
    process.stdout.write("Tracked artifact changed: docker-compose.yml.\n");
  }
  if (baselineChanged) {
    process.stdout.write(
      "Tracked artifact changed: cpa/config.yaml.example.\n" +
        "Next: review the diff, then run cpa-stack generate before restarting the stack.\n",
    );
  }

  for (const replacement of replacements) {
    replacement.disarm();
  }
};
