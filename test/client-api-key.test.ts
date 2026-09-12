import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestCheckout } from "./support/checkout.ts";

test("quiet pnpm lookup from outside the repo returns only the key and preserves failures", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  for (const [args, status, stdout] of [
    [[], 0, "synthetic-client-key"],
    [["missing-client"], 1, ""],
    [["BAD_INPUT"], 2, ""],
  ] as const) {
    const result = spawnSync(
      "pnpm",
      ["--dir", checkout.root, "--silent", "run", "client-api-key", ...args],
      { cwd: checkout.outsideRoot, encoding: "utf8" },
    );
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, stdout);
    if (status === 0) assert.equal(result.stderr, "");
    else assert.match(result.stderr, /cpa-stack/);
  }
});

test("key-file values are literal data with Node quoting, comments, and duplicate rules", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  for (const [source, expected] of [
    [
      " CPA_CLIENT_API_KEY = synthetic-unquoted-key # comment\n",
      "synthetic-unquoted-key",
    ],
    [
      "export CPA_CLIENT_API_KEY='synthetic $OTHER ${OTHER} $(exit 7) # literal'\n",
      "synthetic $OTHER ${OTHER} $(exit 7) # literal",
    ],
    [
      'CPA_CLIENT_API_KEY="  synthetic quoted key  "\r\n',
      "  synthetic quoted key  ",
    ],
    ["CPA_CLIENT_API_KEY=first\nCPA_CLIENT_API_KEY=last\n", "last"],
  ] as const) {
    await writeFile(join(checkout.root, ".env"), source);
    const result = checkout.runCli(["client-api-key"], {
      OTHER: "must-not-expand",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
  }
});

test("a missing or unreadable key file produces a safe file diagnostic", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const path = join(checkout.root, ".env");
  await rm(path);

  for (const unreadable of [false, true]) {
    if (unreadable) await mkdir(path);
    const result = checkout.runCli(["client-api-key"], {
      CPA_CLIENT_API_KEY: "synthetic-inherited-secret",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `cpa-stack: cannot read ${path}\n`);
  }
});

test("missing or empty client API keys fail without falling back or leaking secrets", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  for (const [source, args, variable] of [
    [
      "CPA_CLIENT_API_KEY=synthetic-default-secret\n",
      ["pi"],
      "CPA_CLIENT_API_KEY_PI",
    ],
    [
      "CPA_CLIENT_API_KEY_PI=''\nCPA_CLIENT_API_KEY=synthetic-default-secret\n",
      ["pi"],
      "CPA_CLIENT_API_KEY_PI",
    ],
    ["UNRELATED=synthetic-other-secret\n", [], "CPA_CLIENT_API_KEY"],
    ["CPA_CLIENT_API_KEY=''\n", [], "CPA_CLIENT_API_KEY"],
  ] as const) {
    await writeFile(join(checkout.root, ".env"), source);
    const result = checkout.runCli(["client-api-key", ...args], {
      CPA_CLIENT_API_KEY: "synthetic-inherited-secret",
      CPA_CLIENT_API_KEY_PI: "synthetic-inherited-pi-secret",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `cpa-stack: ${variable} is not set in ${join(checkout.root, ".env")}\n`,
    );
  }
});

test("invalid client arguments fail without echoing input or reading the key file", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  for (const args of [
    [""],
    ["CLAUDE-CODE"],
    ["claude_code"],
    ["-pi"],
    ["pi-"],
    ["new--tool"],
    ["pi\n"],
    ["--help"],
    ["pi", "extra"],
    ["synthetic-secret/input"],
  ]) {
    const result = checkout.runCli(["client-api-key", ...args]);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /client-api-key \[client\]/);
    assert.ok(!result.stderr.includes("synthetic-secret"));
  }
});

test("client names select keys dynamically with hyphens mapped to underscores", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(
    join(checkout.root, ".env"),
    "CPA_CLIENT_API_KEY=synthetic-default-key\n" +
      "CPA_CLIENT_API_KEY_CLAUDE_CODE=synthetic-claude-key\n" +
      "CPA_CLIENT_API_KEY_PI=synthetic-pi-key\n" +
      "CPA_CLIENT_API_KEY_NEW_TOOL_2=synthetic-new-key\n",
  );

  for (const [client, expected] of [
    ["claude-code", "synthetic-claude-key"],
    ["pi", "synthetic-pi-key"],
    ["new-tool-2", "synthetic-new-key"],
  ]) {
    const result = checkout.runCli(["client-api-key", client!]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
  }
});

test("client API key lookup reads the checkout default, not the caller's file or environment", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  await writeFile(
    join(checkout.outsideRoot, ".env"),
    "CPA_CLIENT_API_KEY=synthetic-outside-key\n",
  );

  const result = checkout.runCli(["client-api-key"], {
    CPA_CLIENT_API_KEY: "synthetic-inherited-key",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "synthetic-client-key");
  assert.equal(result.stderr, "");
});
