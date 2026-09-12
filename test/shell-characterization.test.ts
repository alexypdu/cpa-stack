import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { createTestCheckout } from "./support/checkout.ts";

const fakeYq = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("yq (https://github.com/mikefarah/yq/) version v4.53.6\\n");
} else if (args[0] === "eval-all") {
  process.stdout.write("generated: override\\n");
} else if (args[1] === '{"x-cpa-stack-override": .}') {
  process.stdout.write("x-cpa-stack-override:\\n  generated: override\\n");
} else if (args[1] === '."x-cpa-stack-override"') {
  process.stdout.write("generated: override\\n");
} else {
  process.exitCode = 1;
}
`;

const fakeSyncYq = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("yq (https://github.com/mikefarah/yq/) version v4.53.6\\n");
  process.exit(0);
}
const expression = args.at(-2);
const path = args.at(-1);
const contents = readFileSync(path, "utf8");
if (expression?.includes('services."cli-proxy-api".image')) {
  process.stdout.write(contents.match(/eceasy\\/cli-proxy-api:[^\\s#]+/)[0] + "\\n");
} else if (expression?.includes('services."cpa-usage-keeper".image')) {
  process.stdout.write(contents.match(/ghcr\\.io\\/willxup\\/cpa-usage-keeper:[^\\s#]+/)[0] + "\\n");
} else if (expression === ".draft" || expression === ".prerelease" || expression === ".tag_name") {
  const metadata = JSON.parse(contents);
  const key = expression.slice(1);
  process.stdout.write(String(metadata[key]) + "\\n");
}
`;

const fakeCurl = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const destination = args[args.indexOf("-o") + 1];
const url = args.at(-1);
if (process.env.COMMAND_LOG) appendFileSync(process.env.COMMAND_LOG, JSON.stringify(["curl", url]) + "\\n");
if (url.includes("CLIProxyAPI/releases/latest")) {
  writeFileSync(destination, JSON.stringify({ draft: false, prerelease: false, tag_name: process.env.FIXTURE_CPA_TAG }));
} else if (url.includes("cpa-usage-keeper/releases/latest")) {
  writeFileSync(destination, JSON.stringify({ draft: false, prerelease: false, tag_name: process.env.FIXTURE_KEEPER_TAG }));
} else {
  writeFileSync(destination, process.env.BASELINE_BYTES);
}
`;

const fakeSyncDocker = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.COMMAND_LOG) appendFileSync(process.env.COMMAND_LOG, JSON.stringify(["docker", ...args]) + "\\n");
const image = args.at(-1);
if (image?.includes("cpa-usage-keeper") && process.env.KEEPER_AVAILABLE === "false") process.exitCode = 1;
if (image?.includes("cli-proxy-api") && process.env.CPA_AVAILABLE === "false") process.exitCode = 1;
`;

const fakeDocker = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.COMMAND_LOG) {
  appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
}
if (args.includes("config")) {
  process.stdout.write("x-cpa-stack-override:\\n  generated: override\\n");
}
if (args.includes("ps") && process.env.DOCKER_PS_OUTPUT) {
  process.stdout.write(process.env.DOCKER_PS_OUTPUT);
}
`;

test("shell generation rotates the backup and removes intermediates", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const yq = await checkout.installCommand("yq", fakeYq);
  await checkout.installCommand("docker", fakeDocker);
  const fakeBin = dirname(yq);
  const temporaryRoot = join(checkout.root, "temporary");
  await mkdir(temporaryRoot);
  const baseline = join(checkout.root, "cpa/config.yaml.example");
  const override = join(checkout.root, "cpa/config.yaml.override");
  const effective = join(checkout.root, "cpa/config.yaml");
  const backup = join(checkout.root, "cpa/config.yaml.backup");
  const baselineBytes = await readFile(baseline);
  const overrideBytes = await readFile(override);
  await writeFile(effective, "previous: effective\n");
  await writeFile(backup, "older: backup\n");

  const result = checkout.runLegacyCli(["generate"], {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    TMPDIR: temporaryRoot,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Generated cpa/config.yaml with mode 0600.\n");
  assert.equal(await readFile(effective, "utf8"), "generated: override\n");
  assert.equal(await readFile(backup, "utf8"), "previous: effective\n");
  assert.equal((await stat(effective)).mode & 0o777, 0o600);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(baseline), baselineBytes);
  assert.deepEqual(await readFile(override), overrideBytes);
  assert.deepEqual(await readdir(temporaryRoot), []);
  assert.deepEqual(
    (await readdir(join(checkout.root, "cpa"))).filter((name) => name.startsWith(".")),
    [],
  );
});

test("shell restart reports an immediately exited service without hidden pulls", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const commandLog = join(checkout.root, "docker-commands.jsonl");
  await writeFile(join(checkout.root, "cpa/config.yaml"), "synthetic: effective\n");

  const result = checkout.runLegacyCli(["restart"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMMAND_LOG: commandLog,
    DOCKER_PS_OUTPUT: "cli-proxy-api\n",
  });
  const commands = (await readFile(commandLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: service exited during startup: cli-proxy-api\n",
  );
  assert.ok(commands.some((args) => args.includes("up") && args.includes("--force-recreate")));
  assert.ok(commands.some((args) => args.includes("ps") && args.includes("exited")));
  assert.ok(commands.every((args) => !args.includes("pull")));
});

test("shell sync advances only the service with an available image", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const yq = await checkout.installCommand("yq", fakeSyncYq);
  await checkout.installCommand("curl", fakeCurl);
  await checkout.installCommand("docker", fakeSyncDocker);
  const commandLog = join(checkout.root, "sync-commands.jsonl");
  const baseline = join(checkout.root, "cpa/config.yaml.example");

  const result = checkout.runLegacyCli(["sync"], {
    PATH: `${dirname(yq)}:${process.env.PATH ?? ""}`,
    COMMAND_LOG: commandLog,
    FIXTURE_CPA_TAG: "v2.0.0",
    FIXTURE_KEEPER_TAG: "v2.0.0",
    CPA_AVAILABLE: "true",
    KEEPER_AVAILABLE: "false",
    BASELINE_BYTES: "port: 9000\n",
  });
  const compose = await readFile(join(checkout.root, "docker-compose.yml"), "utf8");
  const commands = (await readFile(commandLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(compose, /eceasy\/cli-proxy-api:v2\.0\.0/);
  assert.match(compose, /cpa-usage-keeper:v1\.0\.0/);
  assert.equal(await readFile(baseline, "utf8"), "port: 9000\n");
  assert.ok(
    commands.some((args) => args.includes("ghcr.io/willxup/cpa-usage-keeper:v2.0.0")),
    JSON.stringify(commands),
  );
  assert.match(result.stdout, /Keeper: selected v1\.0\.0, but its image is unavailable; kept v1\.0\.0\./);
  assert.match(result.stdout, /Next: review the diff, then run \.\/cpa-stack generate/);
  assert.ok(commands.some((args) => args[0] === "docker" && args[1] === "manifest"));
  assert.ok(commands.every((args) => !args.includes("pull")));
});

test("shell sync omits regeneration guidance for a byte-identical baseline", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const yq = await checkout.installCommand("yq", fakeSyncYq);
  await checkout.installCommand("curl", fakeCurl);
  await checkout.installCommand("docker", fakeSyncDocker);
  const originalBaseline = await readFile(
    join(checkout.root, "cpa/config.yaml.example"),
    "utf8",
  );

  const result = checkout.runLegacyCli(["sync"], {
    PATH: `${dirname(yq)}:${process.env.PATH ?? ""}`,
    FIXTURE_CPA_TAG: "v2.0.0",
    FIXTURE_KEEPER_TAG: "v1.0.0",
    CPA_AVAILABLE: "true",
    KEEPER_AVAILABLE: "true",
    BASELINE_BYTES: originalBaseline,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CPA: selected v2\.0\.0 \(updated\)\./);
  assert.match(result.stdout, /Upstream baseline: unchanged\./);
  assert.doesNotMatch(result.stdout, /run \.\/cpa-stack generate/);
});
