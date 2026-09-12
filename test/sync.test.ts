import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import test from "node:test";

import { createTestCheckout, type TestCheckout } from "./support/checkout.ts";

const cpaReleaseUrl =
  "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const keeperReleaseUrl =
  "https://api.github.com/repos/Willxup/cpa-usage-keeper/releases/latest";
const baselineUrl =
  "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v2.0.0/config.example.yaml";

interface SyncFixture {
  checkout: TestCheckout;
  commandLog: string;
  env: NodeJS.ProcessEnv;
}

async function createSyncFixture(): Promise<SyncFixture> {
  const checkout = await createTestCheckout();
  const commandLog = join(checkout.root, "sync-commands.jsonl");
  await checkout.installCommand(
    "curl",
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SYNC_COMMAND_LOG, JSON.stringify(["curl", ...args]) + "\\n");
const destination = args[args.indexOf("-o") + 1];
const url = args.at(-1);
const responses = JSON.parse(process.env.SYNC_RESPONSES);
if (!(url in responses)) process.exit(22);
writeFileSync(destination, responses[url]);
`,
  );
  await checkout.installCommand(
    "docker",
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SYNC_COMMAND_LOG, JSON.stringify(["docker", ...args]) + "\\n");
const unavailable = JSON.parse(process.env.SYNC_UNAVAILABLE_IMAGES ?? "[]");
if (args[0] !== "manifest" || args[1] !== "inspect") process.exit(91);
if (args[2] === process.env.SYNC_EDIT_ON_IMAGE) {
  const { appendFileSync: editFile } = await import("node:fs");
  editFile(process.env.SYNC_EDIT_PATH, "# concurrent local edit\\n");
}
if (unavailable.includes(args[2])) process.exit(1);
`,
  );

  return {
    checkout,
    commandLog,
    env: {
      PATH: `${join(checkout.root, "test-bin")}:${process.env.PATH}`,
      SYNC_COMMAND_LOG: commandLog,
      SYNC_RESPONSES: JSON.stringify({
        [cpaReleaseUrl]: JSON.stringify({
          draft: false,
          prerelease: false,
          tag_name: "v2.0.0",
        }),
        [keeperReleaseUrl]: JSON.stringify({
          draft: false,
          prerelease: false,
          tag_name: "v2.0.0",
        }),
        [baselineUrl]: "# exact upstream bytes\nport: 8318\n",
      }),
      SYNC_UNAVAILABLE_IMAGES: "[]",
    },
  };
}

function setResponse(
  fixture: SyncFixture,
  url: string,
  response: string | undefined,
): void {
  const responses = JSON.parse(fixture.env.SYNC_RESPONSES ?? "{}") as Record<
    string,
    string
  >;
  if (response === undefined) {
    delete responses[url];
  } else {
    responses[url] = response;
  }
  fixture.env.SYNC_RESPONSES = JSON.stringify(responses);
}

async function readCommandLog(path: string): Promise<string[][]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("sync adopts available releases and preserves Compose content", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  await writeFile(
    join(fixture.checkout.root, "docker-compose.yml"),
    "# stack comment\n" +
      "services:\n" +
      "  cli-proxy-api:\n" +
      "    image: eceasy/cli-proxy-api:v1.0.0 # CPA pin\n" +
      "    restart: unless-stopped\n" +
      "  cpa-usage-keeper:\n" +
      "    image: ghcr.io/willxup/cpa-usage-keeper:v1.0.0 # Keeper pin\n",
  );
  assert.equal(
    fixture.checkout.runGit(["add", "docker-compose.yml"]).status,
    0,
  );
  assert.equal(
    fixture.checkout.runGit(["commit", "-qm", "test: customize compose"])
      .status,
    0,
  );

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "CPA: selected v2.0.0 (updated).\n" +
      "Keeper: selected v2.0.0 (updated).\n" +
      "Upstream baseline: updated cpa/config.yaml.example.\n" +
      "Tracked artifact changed: docker-compose.yml.\n" +
      "Tracked artifact changed: cpa/config.yaml.example.\n" +
      "Next: review the diff, then run cpa-stack generate before restarting the stack.\n",
  );
  assert.equal(
    await readFile(join(fixture.checkout.root, "docker-compose.yml"), "utf8"),
    "# stack comment\n" +
      "services:\n" +
      "  cli-proxy-api:\n" +
      "    image: eceasy/cli-proxy-api:v2.0.0 # CPA pin\n" +
      "    restart: unless-stopped\n" +
      "  cpa-usage-keeper:\n" +
      "    image: ghcr.io/willxup/cpa-usage-keeper:v2.0.0 # Keeper pin\n",
  );
  assert.equal(
    await readFile(
      join(fixture.checkout.root, "cpa/config.yaml.example"),
      "utf8",
    ),
    "# exact upstream bytes\nport: 8318\n",
  );
  assert.equal(
    (await stat(join(fixture.checkout.root, "docker-compose.yml"))).mode &
      0o777,
    0o644,
  );
  assert.equal(
    (await stat(join(fixture.checkout.root, "cpa/config.yaml.example"))).mode &
      0o777,
    0o644,
  );

  const commands = await readCommandLog(fixture.commandLog);
  assert.deepEqual(
    commands.map(([command, ...args]) => [
      command,
      ...args.map((arg, index) =>
        args[index - 1] === "-o" ? basename(arg ?? "") : arg,
      ),
    ]),
    [
      [
        "curl",
        "-fsSL",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "-o",
        "cpa-release.json",
        cpaReleaseUrl,
      ],
      [
        "curl",
        "-fsSL",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "-o",
        "keeper-release.json",
        keeperReleaseUrl,
      ],
      ["docker", "manifest", "inspect", "eceasy/cli-proxy-api:v2.0.0"],
      [
        "curl",
        "-fsSL",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "-o",
        "config.yaml.example",
        baselineUrl,
      ],
      [
        "docker",
        "manifest",
        "inspect",
        "ghcr.io/willxup/cpa-usage-keeper:v2.0.0",
      ],
    ],
  );
  const untracked = fixture.checkout.runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  assert.equal(untracked.status, 0);
  assert.doesNotMatch(untracked.stdout, /cpa-stack-(?:sync|stage)|rollback/);
});

test("sync keeps an unavailable CPA release while updating Keeper", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  fixture.env.SYNC_UNAVAILABLE_IMAGES = JSON.stringify([
    "eceasy/cli-proxy-api:v2.0.0",
  ]);
  const originalBaseline = await readFile(
    join(fixture.checkout.root, "cpa/config.yaml.example"),
  );

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "CPA: selected v2.0.0, but its image is unavailable; kept v1.0.0.\n" +
      "Keeper: selected v2.0.0 (updated).\n" +
      "Upstream baseline: unchanged.\n" +
      "Tracked artifact changed: docker-compose.yml.\n",
  );
  assert.match(
    await readFile(join(fixture.checkout.root, "docker-compose.yml"), "utf8"),
    /eceasy\/cli-proxy-api:v1\.0\.0[\s\S]*cpa-usage-keeper:v2\.0\.0/,
  );
  assert.deepEqual(
    await readFile(join(fixture.checkout.root, "cpa/config.yaml.example")),
    originalBaseline,
  );
  const commands = await readCommandLog(fixture.commandLog);
  assert.equal(
    commands.some((command) => command.at(-1) === baselineUrl),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes("pull")),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes("up")),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes("config")),
    false,
  );
});

test("sync reports a baseline-only change and requests regeneration", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  const responses = JSON.parse(fixture.env.SYNC_RESPONSES ?? "{}") as Record<
    string,
    string
  >;
  responses[cpaReleaseUrl] = JSON.stringify({
    draft: false,
    prerelease: false,
    tag_name: "v1.0.0",
  });
  responses[keeperReleaseUrl] = JSON.stringify({
    draft: false,
    prerelease: false,
    tag_name: "v1.0.0",
  });
  responses[
    "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v1.0.0/config.example.yaml"
  ] = "port: 9000\n";
  fixture.env.SYNC_RESPONSES = JSON.stringify(responses);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "CPA: selected v1.0.0 (unchanged).\n" +
      "Keeper: selected v1.0.0 (unchanged).\n" +
      "Upstream baseline: updated cpa/config.yaml.example.\n" +
      "Tracked artifact changed: cpa/config.yaml.example.\n" +
      "Next: review the diff, then run cpa-stack generate before restarting the stack.\n",
  );
  assert.equal(
    fixture.checkout.runGit(["diff", "--quiet", "--", "docker-compose.yml"])
      .status,
    0,
  );
  assert.equal(
    await readFile(
      join(fixture.checkout.root, "cpa/config.yaml.example"),
      "utf8",
    ),
    "port: 9000\n",
  );
});

test("sync does not request regeneration for a pin-only change", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  const currentBaseline = await readFile(
    join(fixture.checkout.root, "cpa/config.yaml.example"),
    "utf8",
  );
  const responses = JSON.parse(fixture.env.SYNC_RESPONSES ?? "{}") as Record<
    string,
    string
  >;
  responses[baselineUrl] = currentBaseline;
  fixture.env.SYNC_RESPONSES = JSON.stringify(responses);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CPA: selected v2\.0\.0 \(updated\)\./);
  assert.match(result.stdout, /Upstream baseline: unchanged\./);
  assert.doesNotMatch(result.stdout, /Next:/);
  assert.doesNotMatch(
    result.stdout,
    /Tracked artifact changed: cpa\/config\.yaml\.example/,
  );
});

for (const [path, staged] of [
  ["docker-compose.yml", false],
  ["docker-compose.yml", true],
  ["cpa/config.yaml.example", false],
  ["cpa/config.yaml.example", true],
] as const) {
  test(`sync rejects ${staged ? "staged" : "unstaged"} edits to ${path} before network work`, async (t) => {
    const fixture = await createSyncFixture();
    t.after(() => fixture.checkout.cleanup());
    await writeFile(join(fixture.checkout.root, path), "local edit\n", {
      flag: "a",
    });
    if (staged) {
      assert.equal(fixture.checkout.runGit(["add", path]).status, 0);
    }

    const result = fixture.checkout.runCli(["sync"], fixture.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `cpa-stack: refusing to overwrite pre-existing changes to: ${path}\n`,
    );
    assert.deepEqual(await readCommandLog(fixture.commandLog), []);
  });
}

test("sync permits unrelated local work", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  await writeFile(
    join(fixture.checkout.root, "operator-notes.txt"),
    "keep me\n",
  );

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(fixture.checkout.root, "operator-notes.txt"), "utf8"),
    "keep me\n",
  );
});

test("sync repeats dirty-file protection immediately before replacement", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  const composePath = join(fixture.checkout.root, "docker-compose.yml");
  const baselinePath = join(fixture.checkout.root, "cpa/config.yaml.example");
  const originalBaseline = await readFile(baselinePath);
  fixture.env.SYNC_EDIT_ON_IMAGE = "ghcr.io/willxup/cpa-usage-keeper:v2.0.0";
  fixture.env.SYNC_EDIT_PATH = composePath;

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: refusing to overwrite pre-existing changes to: docker-compose.yml\n",
  );
  assert.match(await readFile(composePath, "utf8"), /# concurrent local edit/);
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
});

for (const [name, metadata, diagnostic] of [
  ["array metadata", [], "CPA release metadata is malformed"],
  [
    "a non-boolean draft field",
    { draft: "false", prerelease: false, tag_name: "v2.0.0" },
    "CPA release metadata is malformed",
  ],
  [
    "a non-boolean prerelease field",
    { draft: false, prerelease: 0, tag_name: "v2.0.0" },
    "CPA release metadata is malformed",
  ],
  [
    "a non-string tag",
    { draft: false, prerelease: false, tag_name: 2 },
    "CPA release metadata is malformed",
  ],
  [
    "an empty tag",
    { draft: false, prerelease: false, tag_name: "" },
    "CPA release metadata has an invalid tag",
  ],
  [
    "an invalid tag character",
    { draft: false, prerelease: false, tag_name: "v2/latest" },
    "CPA release metadata has an invalid tag",
  ],
  [
    "a draft",
    { draft: true, prerelease: false, tag_name: "v2.0.0" },
    "CPA latest release is a draft",
  ],
  [
    "a prerelease",
    { draft: false, prerelease: true, tag_name: "v2.0.0" },
    "CPA latest release is a prerelease",
  ],
] as const) {
  test(`sync rejects ${name}`, async (t) => {
    const fixture = await createSyncFixture();
    t.after(() => fixture.checkout.cleanup());
    setResponse(fixture, cpaReleaseUrl, JSON.stringify(metadata));

    const result = fixture.checkout.runCli(["sync"], fixture.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
  });
}

test("sync validates Keeper release metadata independently", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  setResponse(
    fixture,
    keeperReleaseUrl,
    JSON.stringify({ draft: false, prerelease: false, tag_name: "bad tag" }),
  );

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: Keeper release metadata has an invalid tag\n",
  );
});

test("sync reports a failed release lookup", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  setResponse(fixture, keeperReleaseUrl, undefined);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: could not download Keeper release metadata\n",
  );
});

for (const [source, diagnostic] of [
  ["services: [\n", "docker-compose.yml is not valid YAML"],
  [
    "services:\n  cli-proxy-api: {}\n  cpa-usage-keeper:\n    image: ghcr.io/willxup/cpa-usage-keeper:v1.0.0\n",
    "could not read the CPA image declaration",
  ],
  [
    "services:\n  cli-proxy-api:\n    image: eceasy/cli-proxy-api:v1.0.0\n  cpa-usage-keeper: {}\n",
    "could not read the Keeper image declaration",
  ],
] as const) {
  test(`sync rejects invalid Compose input: ${diagnostic}`, async (t) => {
    const fixture = await createSyncFixture();
    t.after(() => fixture.checkout.cleanup());
    await writeFile(join(fixture.checkout.root, "docker-compose.yml"), source);
    fixture.checkout.runGit(["add", "docker-compose.yml"]);
    fixture.checkout.runGit(["commit", "-qm", "test: use invalid compose"]);

    const result = fixture.checkout.runCli(["sync"], fixture.env);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
    assert.deepEqual(await readCommandLog(fixture.commandLog), []);
  });
}

for (const [service, source, diagnostic] of [
  [
    "CPA",
    "services:\n  cli-proxy-api:\n    image: example/cpa:v1\n  cpa-usage-keeper:\n    image: ghcr.io/willxup/cpa-usage-keeper:v1.0.0\n",
    "docker-compose.yml has an unexpected CPA image declaration",
  ],
  [
    "Keeper",
    "services:\n  cli-proxy-api:\n    image: eceasy/cli-proxy-api:v1.0.0\n  cpa-usage-keeper:\n    image: example/keeper:v1\n",
    "docker-compose.yml has an unexpected Keeper image declaration",
  ],
] as const) {
  test(`sync rejects the wrong current ${service} repository`, async (t) => {
    const fixture = await createSyncFixture();
    t.after(() => fixture.checkout.cleanup());
    await writeFile(join(fixture.checkout.root, "docker-compose.yml"), source);
    fixture.checkout.runGit(["add", "docker-compose.yml"]);
    fixture.checkout.runGit(["commit", "-qm", "test: use wrong repository"]);

    const result = fixture.checkout.runCli(["sync"], fixture.env);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
    assert.deepEqual(await readCommandLog(fixture.commandLog), []);
  });
}

for (const [path, key] of [
  ["docker-compose.yml", "compose"],
  ["cpa/config.yaml.example", "baseline"],
] as const) {
  test(`sync requires the ${key} file`, async (t) => {
    const fixture = await createSyncFixture();
    t.after(() => fixture.checkout.cleanup());
    const absolutePath = join(fixture.checkout.root, path);
    await rm(absolutePath);

    const result = fixture.checkout.runCli(["sync"], fixture.env);

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      `cpa-stack: required file not found: ${absolutePath}\n`,
    );
  });
}

for (const [missing, diagnostic] of [
  ["curl", "curl is required"],
  ["docker", "Docker is required to verify image availability"],
  ["git", "Git is required"],
] as const) {
  test(`sync reports a missing ${missing} dependency`, async (t) => {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    for (const name of ["curl", "docker", "git"]) {
      if (name !== missing) {
        await checkout.installCommand(name, "#!/bin/sh\nexit 0\n");
      }
    }

    const result = checkout.runCli(["sync"], {
      PATH: join(checkout.root, "test-bin"),
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
  });
}

for (const [baseline, diagnostic] of [
  ["", "the CPA v2.0.0 upstream baseline is empty"],
  [
    "- not-a-mapping\n",
    "the CPA v2.0.0 upstream baseline is not a valid YAML mapping",
  ],
  ["key: [\n", "the CPA v2.0.0 upstream baseline is not a valid YAML mapping"],
] as const) {
  test(`sync rejects ${diagnostic}`, async (t) => {
    const fixture = await createSyncFixture();
    t.after(() => fixture.checkout.cleanup());
    setResponse(fixture, baselineUrl, baseline);
    const originalCompose = await readFile(
      join(fixture.checkout.root, "docker-compose.yml"),
    );
    const originalBaseline = await readFile(
      join(fixture.checkout.root, "cpa/config.yaml.example"),
    );

    const result = fixture.checkout.runCli(["sync"], fixture.env);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
    assert.deepEqual(
      await readFile(join(fixture.checkout.root, "docker-compose.yml")),
      originalCompose,
    );
    assert.deepEqual(
      await readFile(join(fixture.checkout.root, "cpa/config.yaml.example")),
      originalBaseline,
    );
  });
}

test("sync fails wholly when the CPA baseline download fails", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  setResponse(fixture, baselineUrl, undefined);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: could not download the CPA v2.0.0 upstream baseline\n",
  );
  assert.equal(fixture.checkout.runGit(["diff", "--quiet"]).status, 0);
});

test("sync updates CPA and its baseline when Keeper is unavailable", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  fixture.env.SYNC_UNAVAILABLE_IMAGES = JSON.stringify([
    "ghcr.io/willxup/cpa-usage-keeper:v2.0.0",
  ]);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CPA: selected v2\.0\.0 \(updated\)\./);
  assert.match(
    result.stdout,
    /Keeper: selected v2\.0\.0, but its image is unavailable; kept v1\.0\.0\./,
  );
  assert.match(result.stdout, /Upstream baseline: updated/);
  assert.match(
    await readFile(join(fixture.checkout.root, "docker-compose.yml"), "utf8"),
    /cli-proxy-api:v2\.0\.0[\s\S]*cpa-usage-keeper:v1\.0\.0/,
  );
});

test("sync keeps both services and the baseline when both images are unavailable", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  fixture.env.SYNC_UNAVAILABLE_IMAGES = JSON.stringify([
    "eceasy/cli-proxy-api:v2.0.0",
    "ghcr.io/willxup/cpa-usage-keeper:v2.0.0",
  ]);
  const composePath = join(fixture.checkout.root, "docker-compose.yml");
  const baselinePath = join(fixture.checkout.root, "cpa/config.yaml.example");
  const originalCompose = await readFile(composePath);
  const originalBaseline = await readFile(baselinePath);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CPA: selected .* image is unavailable/);
  assert.match(result.stdout, /Keeper: selected .* image is unavailable/);
  assert.match(result.stdout, /Upstream baseline: unchanged/);
  assert.doesNotMatch(result.stdout, /Tracked artifact changed/);
  assert.deepEqual(await readFile(composePath), originalCompose);
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  assert.equal(
    (await readCommandLog(fixture.commandLog)).some(
      (command) => command.at(-1) === baselineUrl,
    ),
    false,
  );
});

test("sync does not rewrite unchanged tracked artifacts", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  const responses = JSON.parse(fixture.env.SYNC_RESPONSES ?? "{}") as Record<
    string,
    string
  >;
  responses[cpaReleaseUrl] = JSON.stringify({
    draft: false,
    prerelease: false,
    tag_name: "v1.0.0",
  });
  responses[keeperReleaseUrl] = JSON.stringify({
    draft: false,
    prerelease: false,
    tag_name: "v1.0.0",
  });
  responses[
    "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v1.0.0/config.example.yaml"
  ] = await readFile(
    join(fixture.checkout.root, "cpa/config.yaml.example"),
    "utf8",
  );
  fixture.env.SYNC_RESPONSES = JSON.stringify(responses);
  const composePath = join(fixture.checkout.root, "docker-compose.yml");
  const baselinePath = join(fixture.checkout.root, "cpa/config.yaml.example");
  const composeBefore = await stat(composePath);
  const baselineBefore = await stat(baselinePath);

  const result = fixture.checkout.runCli(["sync"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("Tracked artifact changed"), false);
  const composeAfter = await stat(composePath);
  const baselineAfter = await stat(baselinePath);
  assert.equal(composeAfter.ino, composeBefore.ino);
  assert.equal(baselineAfter.ino, baselineBefore.ino);
});

test("sync leaves artifacts untouched when rollback preparation fails", async (t) => {
  const fixture = await createSyncFixture();
  t.after(() => fixture.checkout.cleanup());
  const realGit = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => join(entry, "git"))
    .find(existsSync);
  assert.ok(realGit);
  const counter = join(fixture.checkout.root, "git-counter");
  const baselinePath = join(fixture.checkout.root, "cpa/config.yaml.example");
  await fixture.checkout.installCommand(
    "git",
    `#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const count = existsSync(process.env.SYNC_GIT_COUNTER)
  ? Number(readFileSync(process.env.SYNC_GIT_COUNTER, "utf8")) + 1
  : 1;
writeFileSync(process.env.SYNC_GIT_COUNTER, String(count));
const result = spawnSync(process.env.SYNC_REAL_GIT, process.argv.slice(2), {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (count === 8 && result.status === 0) {
  chmodSync(process.env.SYNC_BREAK_BASELINE, 0);
}
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
  );
  fixture.env.SYNC_GIT_COUNTER = counter;
  fixture.env.SYNC_REAL_GIT = realGit;
  fixture.env.SYNC_BREAK_BASELINE = baselinePath;
  const composePath = join(fixture.checkout.root, "docker-compose.yml");
  const originalCompose = await readFile(composePath);
  const originalBaseline = await readFile(baselinePath);

  const result = fixture.checkout.runCli(["sync"], fixture.env);
  await chmod(baselinePath, 0o644);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: could not copy the upstream baseline for rollback\n",
  );
  assert.deepEqual(await readFile(composePath), originalCompose);
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  const untracked = fixture.checkout.runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  assert.doesNotMatch(untracked.stdout, /cpa-stack-(?:sync|stage|rollback)/);
});
