import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { createTestCheckout, type TestCheckout } from "./support/checkout.ts";

function runRestart(checkout: TestCheckout, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(checkout.root, "test/fixtures/restart-cli.ts"), "restart"],
    {
      cwd: checkout.outsideRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

test("restart requires an existing effective config and names generation", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  const result = runRestart(checkout);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "cpa-stack: effective config not found; run cpa-stack generate first\n",
  );
});

test("restart requires the Compose definition and repository environment", async (t) => {
  for (const [relativePath, prepare] of [
    [
      "docker-compose.yml",
      async (root: string) =>
        writeFile(join(root, "cpa/config.yaml"), "port: 8317\n"),
    ],
    [
      ".env",
      async (root: string) => {
        await writeFile(join(root, "cpa/config.yaml"), "port: 8317\n");
        await rm(join(root, ".env"));
      },
    ],
  ] as const) {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    await prepare(checkout.root);
    if (relativePath === "docker-compose.yml") {
      await rm(join(checkout.root, relativePath));
    }

    const result = runRestart(checkout);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `cpa-stack: required file not found: ${join(checkout.root, relativePath)}\n`,
    );
  }
});

test("restart reports missing Docker", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
  const emptyPath = join(checkout.root, "empty-path");
  await mkdir(emptyPath);

  const result = runRestart(checkout, { PATH: emptyPath });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "cpa-stack: Docker with Compose is required\n");
});

test("restart reports missing Docker Compose", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
  const docker = await checkout.installCommand("docker", "#!/bin/sh\nexit 1\n");

  const result = runRestart(checkout, {
    PATH: `${dirname(docker)}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "cpa-stack: Docker Compose is required\n");
});

test("restart validates and recreates exactly CPA and Keeper from the linked checkout", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
  const commandLog = join(checkout.root, "docker-commands.jsonl");
  const docker = await checkout.installCommand(
    "docker",
    `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.DOCKER_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");\n`,
  );

  const result = runRestart(checkout, {
    PATH: `${dirname(docker)}:${process.env.PATH}`,
    DOCKER_LOG: commandLog,
  });

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "Recreated CPA and Keeper; no immediate service exit was observed.\n",
  );
  assert.equal(result.stderr, "");
  const commonArgs = [
    "compose",
    "--project-directory",
    checkout.root,
    "--env-file",
    join(checkout.root, ".env"),
    "-f",
    join(checkout.root, "docker-compose.yml"),
  ];
  const commands = (await readFile(commandLog, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { cwd: string; args: string[] });
  assert.deepEqual(commands, [
    { cwd: checkout.root, args: ["compose", "version"] },
    { cwd: checkout.root, args: [...commonArgs, "config", "--quiet"] },
    {
      cwd: checkout.root,
      args: [
        ...commonArgs,
        "up",
        "-d",
        "--force-recreate",
        "cli-proxy-api",
        "cpa-usage-keeper",
      ],
    },
    {
      cwd: checkout.root,
      args: [
        ...commonArgs,
        "ps",
        "--all",
        "--status",
        "exited",
        "--services",
        "cli-proxy-api",
        "cpa-usage-keeper",
      ],
    },
  ]);
  assert.equal(
    commands.some(({ args }) =>
      args.some((arg) =>
        ["pull", "sync", "generate", "down", "rm"].includes(arg),
      ),
    ),
    false,
  );
});

test("restart preserves validation, recreation, and state-query failures", async (t) => {
  for (const [failure, diagnostic] of [
    ["config", "could not validate the CPA Stack configuration"],
    ["up", "could not recreate the CPA Stack"],
    ["ps", "could not inspect recreated service status"],
  ] as const) {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
    const docker = await checkout.installCommand(
      "docker",
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst operation = args.includes("version") ? "version" : ["config", "up", "ps"].find((name) => args.includes(name));\nif (operation === process.env.FAIL_AT) {\n  process.stderr.write("synthetic-management-key synthetic-login-password synthetic-client-key");\n  process.exitCode = 7;\n}\n`,
    );

    const result = runRestart(checkout, {
      PATH: `${dirname(docker)}:${process.env.PATH}`,
      FAIL_AT: failure,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
    assert.doesNotMatch(result.stderr, /synthetic-(management|login|client)/);
  }
});

test("restart reports Docker launch failures at each operation boundary", async (t) => {
  for (const [removeAfter, diagnostic] of [
    ["version", "could not validate the CPA Stack configuration"],
    ["config", "could not recreate the CPA Stack"],
    ["up", "could not inspect recreated service status"],
  ] as const) {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
    const docker = await checkout.installCommand(
      "docker",
      `#!${process.execPath}\nimport { rmSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst operation = args.includes("version") ? "version" : ["config", "up", "ps"].find((name) => args.includes(name));\nif (operation === process.env.REMOVE_AFTER) rmSync(process.argv[1]);\n`,
    );

    const result = runRestart(checkout, {
      PATH: dirname(docker),
      REMOVE_AFTER: removeAfter,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
  }
});

test("restart reports each immediately exited service as failure", async (t) => {
  for (const [output, names] of [
    ["cli-proxy-api\n", "cli-proxy-api"],
    ["cpa-usage-keeper\n", "cpa-usage-keeper"],
    ["cli-proxy-api\ncpa-usage-keeper\n", "cli-proxy-api, cpa-usage-keeper"],
  ] as const) {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
    const docker = await checkout.installCommand(
      "docker",
      `#!${process.execPath}\nif (process.argv.includes("ps")) process.stdout.write(process.env.EXITED_SERVICES);\n`,
    );

    const result = runRestart(checkout, {
      PATH: `${dirname(docker)}:${process.env.PATH}`,
      EXITED_SERVICES: output,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `cpa-stack: service exited during startup: ${names}\n`,
    );
  }
});

test("restart preserves bind-mounted state", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(join(checkout.root, "cpa/config.yaml"), "port: 8317\n");
  const sentinels = [
    ["cpa/auths/provider.json", "synthetic-provider-credential\n"],
    ["cpa/logs/current.log", "synthetic-log\n"],
    ["cpa/plugins/plugin.yaml", "synthetic-plugin\n"],
    ["keeper/data.db", "synthetic-keeper-state\n"],
  ] as const;
  for (const [relativePath, contents] of sentinels) {
    const path = join(checkout.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const docker = await checkout.installCommand(
    "docker",
    `#!${process.execPath}\n`,
  );

  const result = runRestart(checkout, { PATH: dirname(docker) });

  assert.equal(result.status, 0);
  for (const [relativePath, contents] of sentinels) {
    assert.equal(
      await readFile(join(checkout.root, relativePath), "utf8"),
      contents,
    );
  }
});
