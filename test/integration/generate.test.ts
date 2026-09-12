import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { createTestCheckout } from "../support/checkout.ts";

function requireCompose(): void {
  const version = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  assert.equal(
    version.status,
    0,
    `Docker Compose is required for integration tests: ${version.stderr || version.stdout}`,
  );
}

test("config generation delegates Compose interpolation semantics without starting containers", async (t) => {
  requireCompose();
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(
    join(checkout.root, "cpa/config.yaml.example"),
    "baseline-only: kept\n",
  );
  await writeFile(
    join(checkout.root, "cpa/config.yaml.override"),
    [
      "inherited-precedence: ${CPA_CLIENT_API_KEY:?client key is required}",
      "env-file-only: ${CPA_MANAGEMENT_KEY:?management key is required}",
      "required: ${GEN_REQUIRED:?GEN_REQUIRED must be set}",
      "unset-default: ${GEN_UNSET-default-for-unset}",
      "empty-default: ${GEN_EMPTY:-default-for-empty}",
      "empty-preserved: ${GEN_EMPTY-default-only-when-unset}",
      "escaped: $$GEN_LITERAL",
      "special: ${GEN_SPECIAL:?GEN_SPECIAL must be set}",
      "",
    ].join("\n"),
  );

  const result = checkout.runCli(["generate"], {
    CPA_CLIENT_API_KEY: "inherited-client-key",
    CPA_MANAGEMENT_KEY: undefined,
    GEN_REQUIRED: "required-value",
    GEN_EMPTY: "",
    GEN_SPECIAL: "spaces : # $ [] {} quotes '\" and \\",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    parse(await readFile(join(checkout.root, "cpa/config.yaml"), "utf8")),
    {
      "baseline-only": "kept",
      "inherited-precedence": "inherited-client-key",
      "env-file-only": "synthetic-management-key",
      required: "required-value",
      "unset-default": "default-for-unset",
      "empty-default": "default-for-empty",
      "empty-preserved": "",
      escaped: "$GEN_LITERAL",
      special: "spaces : # $ [] {} quotes '\" and \\",
    },
  );
});

test("a Compose required-variable failure leaves the effective config unchanged", async (t) => {
  requireCompose();
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const effective = join(checkout.root, "cpa/config.yaml");
  await writeFile(
    join(checkout.root, "cpa/config.yaml.override"),
    "required: ${GEN_REQUIRED:?GEN_REQUIRED must be set}\n",
  );
  await writeFile(effective, "previous: effective\n");

  const result = checkout.runCli(["generate"], { GEN_REQUIRED: undefined });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: could not interpolate the stack override\n",
  );
  assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
});
