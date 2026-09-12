import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { createPackageFixture } from "./support/package.ts";

function runOperation(
  fixture: Awaited<ReturnType<typeof createPackageFixture>>,
  invocation: "npm script" | "linked executable",
  name: "sync" | "generate" | "restart",
  env: NodeJS.ProcessEnv,
) {
  return invocation === "linked executable"
    ? fixture.runLinked([name], env)
    : fixture.runNpm(["--prefix", fixture.checkout.root, "run", name], env);
}

async function poisonYq(
  fixture: Awaited<ReturnType<typeof createPackageFixture>>,
): Promise<NodeJS.ProcessEnv> {
  const yq = await fixture.checkout.installCommand(
    "yq",
    "#!/bin/sh\nexit 97\n",
  );
  return { PATH: `${dirname(yq)}:${process.env.PATH}` };
}

test("the npm-linked executable reports usage outside its checkout", async (t) => {
  const fixture = await createPackageFixture();
  t.after(() => fixture.cleanup());

  const result = fixture.runLinked([]);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: cpa-stack {sync|generate|restart}\nRequires Node.js >=24.12.0.\n",
  );
  await fixture.assertCheckoutDependenciesUnchanged();
});

test("the npm-linked executable reports an operational error outside its checkout", async (t) => {
  const fixture = await createPackageFixture();
  t.after(() => fixture.cleanup());
  const yq = await fixture.checkout.installCommand(
    "yq",
    "#!/bin/sh\nexit 97\n",
  );

  const result = fixture.runLinked(["generate"], {
    PATH: `${dirname(yq)}:${dirname(process.execPath)}:/nonexistent`,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "cpa-stack: Docker with Compose is required\n");
  await fixture.assertCheckoutDependenciesUnchanged();
});

for (const invocation of ["npm script", "linked executable"] as const) {
  test(`${invocation}: sync updates its checkout without chaining operations`, async (t) => {
    const fixture = await createPackageFixture();
    t.after(() => fixture.cleanup());
    const commandLog = join(
      fixture.checkout.outsideRoot,
      "sync-commands.jsonl",
    );
    const curl = await fixture.checkout.installCommand(
      "curl",
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const url = args.at(-1);
const output = args[args.indexOf("-o") + 1];
const body = url?.includes("CLIProxyAPI/releases") || url?.includes("cpa-usage-keeper/releases")
  ? JSON.stringify({ draft: false, prerelease: false, tag_name: "v2.0.0" })
  : "port: 9000\\n";
appendFileSync(process.env.PACKAGE_COMMAND_LOG, JSON.stringify(["curl", ...args]) + "\\n");
writeFileSync(output, body);
`,
    );
    const docker = await fixture.checkout.installCommand(
      "docker",
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PACKAGE_COMMAND_LOG, JSON.stringify(["docker", ...process.argv.slice(2)]) + "\\n");
`,
    );

    const result = runOperation(fixture, invocation, "sync", {
      ...(await poisonYq(fixture)),
      PATH: `${dirname(curl)}:${dirname(docker)}:${process.env.PATH}`,
      PACKAGE_COMMAND_LOG: commandLog,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /CPA: selected v2\.0\.0 \(updated\)\./);
    assert.match(result.stdout, /Keeper: selected v2\.0\.0 \(updated\)\./);
    assert.equal(result.stderr, "");
    assert.match(
      await readFile(join(fixture.checkout.root, "docker-compose.yml"), "utf8"),
      /cli-proxy-api:v2\.0\.0[\s\S]*cpa-usage-keeper:v2\.0\.0/,
    );
    assert.equal(
      await readFile(
        join(fixture.checkout.root, "cpa/config.yaml.example"),
        "utf8",
      ),
      "port: 9000\n",
    );
    await assert.rejects(
      access(join(fixture.checkout.root, "cpa/config.yaml")),
    );
    assert.deepEqual(
      (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .map(([command, ...args]) => [command, args.at(-1)]),
      [
        [
          "curl",
          "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest",
        ],
        [
          "curl",
          "https://api.github.com/repos/Willxup/cpa-usage-keeper/releases/latest",
        ],
        ["docker", "eceasy/cli-proxy-api:v2.0.0"],
        [
          "curl",
          "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v2.0.0/config.example.yaml",
        ],
        ["docker", "ghcr.io/willxup/cpa-usage-keeper:v2.0.0"],
      ],
    );
    await fixture.assertCheckoutDependenciesUnchanged();
  });

  test(`${invocation}: generate writes the effective config without yq or restart`, async (t) => {
    const fixture = await createPackageFixture();
    t.after(() => fixture.cleanup());
    const commandLog = join(
      fixture.checkout.outsideRoot,
      "generate-commands.jsonl",
    );
    const docker = await fixture.checkout.installCommand(
      "docker",
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.PACKAGE_COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args.at(-1) === "config") {
  process.stdout.write("x-cpa-stack-override:\\n  debug: true\\nservices: {}\\n");
}
`,
    );

    const result = runOperation(fixture, invocation, "generate", {
      ...(await poisonYq(fixture)),
      PATH: `${dirname(docker)}:${process.env.PATH}`,
      PACKAGE_COMMAND_LOG: commandLog,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Generated cpa\/config\.yaml with mode 0600\./);
    assert.equal(result.stderr, "");
    assert.equal(
      await readFile(join(fixture.checkout.root, "cpa/config.yaml"), "utf8"),
      "port: 8317\ndebug: true\n",
    );
    assert.deepEqual(
      (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .map((args) => args.at(-1)),
      ["version", "config"],
    );
    await fixture.assertCheckoutDependenciesUnchanged();
  });

  test(`${invocation}: restart recreates only CPA and Keeper`, async (t) => {
    const fixture = await createPackageFixture();
    t.after(() => fixture.cleanup());
    await writeFile(
      join(fixture.checkout.root, "cpa/config.yaml"),
      "port: 8317\n",
    );
    const commandLog = join(
      fixture.checkout.outsideRoot,
      "restart-commands.jsonl",
    );
    const docker = await fixture.checkout.installCommand(
      "docker",
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PACKAGE_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );

    const result = runOperation(fixture, invocation, "restart", {
      ...(await poisonYq(fixture)),
      PATH: `${dirname(docker)}:${process.env.PATH}`,
      PACKAGE_COMMAND_LOG: commandLog,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /Recreated CPA and Keeper; no immediate service exit was observed\./,
    );
    assert.equal(result.stderr, "");
    assert.deepEqual(
      (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .map((args) => args.at(-1)),
      ["version", "--quiet", "cpa-usage-keeper", "cpa-usage-keeper"],
    );
    const commands = (await readFile(commandLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(commands[2]?.slice(-5), [
      "up",
      "-d",
      "--force-recreate",
      "cli-proxy-api",
      "cpa-usage-keeper",
    ]);
    assert.deepEqual(commands[3]?.slice(-6), [
      "--all",
      "--status",
      "exited",
      "--services",
      "cli-proxy-api",
      "cpa-usage-keeper",
    ]);
    await fixture.assertCheckoutDependenciesUnchanged();
  });
}
