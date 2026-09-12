import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTestCheckout, waitForPath } from "./support/checkout.ts";

test("the harness isolates synthetic repositories from inherited Git hook state", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "cpa-stack-git-env-test-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  const outer = join(workspace, "outer");
  await mkdir(outer);
  const cleanEnvironment = {
    HOME: process.env.HOME,
    HUSKY: "0",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  };
  const runOuterGit = (args: string[]) =>
    spawnSync("git", args, {
      cwd: outer,
      encoding: "utf8",
      env: cleanEnvironment,
    });
  assert.equal(runOuterGit(["init", "-q"]).status, 0);
  await writeFile(join(outer, "marker"), "outer repository\n");
  assert.equal(runOuterGit(["add", "."]).status, 0);
  assert.equal(
    runOuterGit([
      "-c",
      "user.name=CPA Stack Tests",
      "-c",
      "user.email=tests@example.invalid",
      "commit",
      "--no-verify",
      "-qm",
      "test: initialize outer repository",
    ]).status,
    0,
  );
  const originalHead = runOuterGit(["rev-parse", "HEAD"]).stdout.trim();
  const supportUrl = new URL("./support/checkout.ts", import.meta.url).href;

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createTestCheckout } from ${JSON.stringify(supportUrl)}; const checkout = await createTestCheckout(); await checkout.cleanup();`,
    ],
    {
      encoding: "utf8",
      env: {
        ...cleanEnvironment,
        GIT_DIR: join(outer, ".git"),
        GIT_INDEX_FILE: join(outer, ".git/index"),
        GIT_PREFIX: "synthetic-hook-prefix/",
        GIT_WORK_TREE: outer,
        HUSKY: "2",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(runOuterGit(["rev-parse", "HEAD"]).stdout.trim(), originalHead);
  assert.equal(runOuterGit(["status", "--porcelain"]).stdout, "");
});

test("invalid usage prints help to stderr and exits 2", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  for (const args of [[], ["sync", "extra"], ["unknown"]]) {
    const result = checkout.runCli(args);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Usage: cpa-stack {sync|generate|bounce}\n" +
        "       cpa-stack client-api-key [client]\n" +
        "Requires Node.js >=24.12.0.\n",
    );
  }
});

test("a valid command uses resources from its own checkout", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  const result = checkout.runFixtureCli(["sync"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${checkout.root}\n`);
  assert.equal(result.stderr, "");
});

test("external commands preserve argv and expose their result", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const logPath = join(checkout.root, "command.json");
  const executable = await checkout.installCommand(
    "record-command",
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.COMMAND_LOG, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("controlled stdout");\nprocess.stderr.write("controlled stderr");\nprocess.exitCode = 7;\n`,
  );
  const expectedArgs = [
    "two words",
    `single'quote`,
    'double"quote',
    "$VALUE",
    "key: value",
  ];

  const result = checkout.runFixtureCli(["bounce"], {
    FIXTURE_EXECUTABLE: executable,
    FIXTURE_ARGS: JSON.stringify(expectedArgs),
    COMMAND_LOG: logPath,
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(await readFile(logPath, "utf8")), expectedArgs);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 7,
    stdout: "controlled stdout",
    stderr: "controlled stderr",
  });
  assert.equal(result.stderr, "");
});

test("a failed external command triggers rollback and cleanup", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const temporary = join(checkout.root, ".temporary");
  const target = join(checkout.root, "tracked.txt");
  const rollback = join(checkout.root, ".rollback");
  await writeFile(temporary, "temporary");
  await writeFile(target, "replacement");
  await writeFile(rollback, "original");
  const executable = await checkout.installCommand(
    "fail-command",
    "#!/bin/sh\nexit 7\n",
  );

  const result = checkout.runFixtureCli(["bounce"], {
    FIXTURE_ACTION: "external-failure",
    FIXTURE_EXECUTABLE: executable,
    FIXTURE_ARGS: "[]",
    FIXTURE_TEMPORARY: temporary,
    FIXTURE_TARGET: target,
    FIXTURE_ROLLBACK: rollback,
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: synthetic command failed with status 7\n",
  );
  await assert.rejects(access(temporary));
  await assert.rejects(access(rollback));
  assert.equal(await readFile(target, "utf8"), "original");
});

test("successful cleanup removes temporary files and keeps committed bytes", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const temporary = join(checkout.root, ".temporary");
  const target = join(checkout.root, "tracked.txt");
  const rollback = join(checkout.root, ".rollback");
  await writeFile(temporary, "temporary");
  await writeFile(target, "replacement");
  await writeFile(rollback, "original");

  const result = checkout.runFixtureCli(["sync"], {
    FIXTURE_ACTION: "cleanup-success",
    FIXTURE_TEMPORARY: temporary,
    FIXTURE_TARGET: target,
    FIXTURE_ROLLBACK: rollback,
  });

  assert.equal(result.status, 0);
  await assert.rejects(access(temporary));
  await assert.rejects(access(rollback));
  assert.equal(await readFile(target, "utf8"), "replacement");
});

test("failed cleanup restores bytes and removes intermediates", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const temporary = join(checkout.root, ".temporary");
  const target = join(checkout.root, "tracked.txt");
  const rollback = join(checkout.root, ".rollback");
  await writeFile(temporary, "temporary");
  await writeFile(target, "replacement");
  await writeFile(rollback, "original");

  const result = checkout.runFixtureCli(["sync"], {
    FIXTURE_ACTION: "cleanup-failure",
    FIXTURE_TEMPORARY: temporary,
    FIXTURE_TARGET: target,
    FIXTURE_ROLLBACK: rollback,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "cpa-stack: synthetic operation failure\n");
  await assert.rejects(access(temporary));
  await assert.rejects(access(rollback));
  assert.equal(await readFile(target, "utf8"), "original");
});

for (const [signal, expectedStatus] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} restores bytes, cleans up, and exits ${expectedStatus}`, async (t) => {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    const temporary = join(checkout.root, ".temporary");
    const target = join(checkout.root, "tracked.txt");
    const rollback = join(checkout.root, ".rollback");
    const ready = join(checkout.root, ".ready");
    await writeFile(temporary, "temporary");
    await writeFile(target, "replacement");
    await writeFile(rollback, "original");
    const executable = await checkout.installCommand(
      "block-command",
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.READY_FILE, "ready");\nsetInterval(() => {}, 1000);\n`,
    );
    const child = checkout.startFixtureCli(["bounce"], {
      FIXTURE_ACTION: "signal",
      FIXTURE_EXECUTABLE: executable,
      FIXTURE_ARGS: "[]",
      FIXTURE_TEMPORARY: temporary,
      FIXTURE_TARGET: target,
      FIXTURE_ROLLBACK: rollback,
      READY_FILE: ready,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await waitForPath(ready);
    child.kill(signal);
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once("close", (code, exitSignal) =>
        resolve({ code, signal: exitSignal }),
      ),
    );

    assert.deepEqual(result, { code: expectedStatus, signal: null });
    assert.equal(stderr, "");
    await assert.rejects(access(temporary));
    await assert.rejects(access(rollback));
    assert.equal(await readFile(target, "utf8"), "original");
  });
}

test("an operational failure has one prefixed diagnostic", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  const result = checkout.runFixtureCli(["generate"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "cpa-stack: synthetic generation failure\n");
});
