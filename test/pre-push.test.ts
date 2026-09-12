import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../.husky/pre-push", import.meta.url));

async function createCheckout(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cpa-stack-pre-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  function git(args: string[]) {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  }

  await writeFile(join(root, "tracked.txt"), "committed\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: {
        check:
          "node -e \"console.log('validation ran'); process.exit(Number(process.env.CHECK_EXIT || 0))\"",
      },
    }),
  );
  git(["init", "-q"]);
  git(["config", "user.name", "CPA Stack Tests"]);
  git(["config", "user.email", "tests@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-qm", "test: initialize hook checkout"]);

  return {
    root,
    git,
    run(checkExit = "0") {
      return spawnSync("sh", [hook], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CHECK_EXIT: checkExit },
      });
    },
  };
}

test("pre-push rejects unstaged tracked changes before validation", async (t) => {
  const checkout = await createCheckout(t);
  await writeFile(join(checkout.root, "tracked.txt"), "uncommitted\n");

  const result = checkout.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit or stash tracked changes/);
  assert.doesNotMatch(result.stdout, /validation ran/);
});

test("pre-push validates a clean tracked tree despite untracked files", async (t) => {
  const checkout = await createCheckout(t);
  await writeFile(join(checkout.root, "notes.txt"), "untracked\n");

  const result = checkout.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /validation ran/);
});

test("pre-push propagates failed validation", async (t) => {
  const checkout = await createCheckout(t);

  const result = checkout.run("7");

  assert.equal(result.status, 7);
  assert.match(result.stdout, /validation ran/);
});

test("pre-push rejects staged tracked changes before validation", async (t) => {
  const checkout = await createCheckout(t);
  await writeFile(join(checkout.root, "tracked.txt"), "staged\n");
  checkout.git(["add", "tracked.txt"]);

  const result = checkout.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit or stash tracked changes/);
  assert.doesNotMatch(result.stdout, /validation ran/);
});
