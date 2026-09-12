import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestCheckout } from "../support/checkout.ts";

test("Compose resolves a synthetic stack override without starting containers", async (t) => {
  const version = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  assert.equal(
    version.status,
    0,
    `Docker Compose is required for integration tests: ${version.stderr || version.stdout}`,
  );

  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const composeInput = join(checkout.root, "compose-interpolation.yml");
  await writeFile(
    composeInput,
    "x-cpa-stack-override:\n" +
      "  selected: ${SYNTHETIC_VALUE:?SYNTHETIC_VALUE must be set}\n" +
      "services: {}\n",
  );
  const args = [
    "compose",
    "--project-directory",
    checkout.root,
    "--env-file",
    join(checkout.root, ".env"),
    "-f",
    composeInput,
    "config",
  ];

  const result = spawnSync("docker", args, {
    cwd: checkout.outsideRoot,
    encoding: "utf8",
    env: { ...process.env, SYNTHETIC_VALUE: "inherited-value" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /selected: inherited-value/);
  assert.ok(!args.includes("up"));
  assert.ok(!args.includes("pull"));
});
