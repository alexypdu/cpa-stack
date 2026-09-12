import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { parse, stringify } from "yaml";

import { createTestCheckout, waitForPath } from "./support/checkout.ts";

interface CompatibilityManifest {
  mergeCases: Array<{
    id: string;
    accepted: boolean;
    baseline?: unknown;
    override?: unknown;
    expected?: unknown;
  }>;
  yamlBoundaryCases: Array<{
    id: string;
    baselineYaml: string;
    overrideYaml: string;
    outputJsonText: string;
    compatibilityConcern?: boolean;
  }>;
}

const compatibility = JSON.parse(
  await readFile(
    new URL("./fixtures/compatibility/manifest.json", import.meta.url),
    "utf8",
  ),
) as CompatibilityManifest;

const fakeDocker = `#!/usr/bin/env node
import { appendFileSync, statSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.COMMAND_LOG) {
  appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
}
if (args.at(-1) === "version") {
  process.stdout.write("Docker Compose version synthetic\\n");
  process.exitCode = Number(process.env.VERSION_STATUS ?? "0");
} else if (args.at(-1) === "config") {
  if (process.env.MODE_LOG) {
    const input = args[args.indexOf("-f") + 1];
    writeFileSync(process.env.MODE_LOG, String(statSync(input).mode & 0o777));
  }
  process.stdout.write(process.env.COMPOSE_OUTPUT ?? "");
  process.stderr.write(process.env.COMPOSE_ERROR ?? "");
  process.exitCode = Number(process.env.COMPOSE_STATUS ?? "0");
} else {
  process.exitCode = 2;
}
`;

test("config generation merges the resolved stack override without changing its sources", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const baseline = join(checkout.root, "cpa/config.yaml.example");
  const override = join(checkout.root, "cpa/config.yaml.override");
  const effective = join(checkout.root, "cpa/config.yaml");
  const commandLog = join(checkout.root, "docker-commands.jsonl");
  const modeLog = join(checkout.root, "compose-input-mode.txt");
  await writeFile(
    baseline,
    "mapping:\n  keep: baseline\n  replace: baseline\napi-keys:\n  - baseline-secret\n",
  );
  await writeFile(
    override,
    "# operator comment\nmapping:\n  replace: ${OVERRIDE_VALUE}\n  add: override\napi-keys:\n  - override-secret\n",
  );
  const baselineBytes = await readFile(baseline);
  const overrideBytes = await readFile(override);

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMMAND_LOG: commandLog,
    MODE_LOG: modeLog,
    COMPOSE_OUTPUT:
      "x-cpa-stack-override:\n" +
      "  mapping:\n" +
      "    replace: resolved\n" +
      "    add: override\n" +
      "  api-keys:\n" +
      "    - override-secret\n" +
      "services: {}\n",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Generated cpa/config.yaml with mode 0600.\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(parse(await readFile(effective, "utf8")), {
    mapping: { keep: "baseline", replace: "resolved", add: "override" },
    "api-keys": ["override-secret"],
  });
  assert.equal((await stat(effective)).mode & 0o777, 0o600);
  assert.equal(await readFile(modeLog, "utf8"), String(0o600));
  assert.deepEqual(await readFile(baseline), baselineBytes);
  assert.deepEqual(await readFile(override), overrideBytes);
  assert.deepEqual(
    (await readdir(join(checkout.root, "cpa"))).filter((name) =>
      name.startsWith(".cpa-stack-generate-"),
    ),
    [],
  );

  const commands = (await readFile(commandLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(commands[0], ["compose", "version"]);
  assert.ok(commands[1]?.includes("--project-directory"));
  assert.ok(commands[1]?.includes(checkout.root));
  assert.ok(commands[1]?.includes("--env-file"));
  assert.ok(commands[1]?.includes(join(checkout.root, ".env")));
  assert.equal(commands[1]?.at(-1), "config");
  assert.ok(commands.every((args) => !args.includes("up")));
  assert.ok(commands.every((args) => !args.includes("pull")));
});

for (const record of compatibility.mergeCases) {
  if (
    !record.accepted ||
    record.id === "root-sequence" ||
    record.baseline === undefined ||
    record.override === undefined
  ) {
    continue;
  }

  test(`config generation matches the saved ${record.id} merge result`, async (t) => {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    const docker = await checkout.installCommand("docker", fakeDocker);
    await writeFile(
      join(checkout.root, "cpa/config.yaml.example"),
      stringify(record.baseline),
    );
    await writeFile(
      join(checkout.root, "cpa/config.yaml.override"),
      stringify(record.override),
    );

    const result = checkout.runCli(["generate"], {
      PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
      COMPOSE_OUTPUT: stringify({
        "x-cpa-stack-override": record.override,
        services: {},
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      parse(await readFile(join(checkout.root, "cpa/config.yaml"), "utf8")),
      record.expected,
    );
  });
}

test("config generation rejects root sequences outside the mapping-shaped configuration contract", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  await writeFile(
    join(checkout.root, "cpa/config.yaml.example"),
    "- baseline\n",
  );
  await writeFile(
    join(checkout.root, "cpa/config.yaml.override"),
    "- override\n",
  );

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: the CPA configuration layers must be mappings\n",
  );
});

const incompatibleBoundaryIds = new Set([
  "duplicate-keys",
  "multiple-documents",
]);

for (const record of compatibility.yamlBoundaryCases) {
  if (!incompatibleBoundaryIds.has(record.id)) {
    test(`config generation accepts the saved ${record.id} YAML boundary`, async (t) => {
      const checkout = await createTestCheckout();
      t.after(() => checkout.cleanup());
      const docker = await checkout.installCommand("docker", fakeDocker);
      await writeFile(
        join(checkout.root, "cpa/config.yaml.example"),
        record.baselineYaml,
      );
      await writeFile(
        join(checkout.root, "cpa/config.yaml.override"),
        record.overrideYaml,
      );
      const resolvedOverride = parse(record.overrideYaml);

      const result = checkout.runCli(["generate"], {
        PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
        COMPOSE_OUTPUT: stringify({
          "x-cpa-stack-override": resolvedOverride,
          services: {},
        }),
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        parse(await readFile(join(checkout.root, "cpa/config.yaml"), "utf8")),
        JSON.parse(record.outputJsonText),
      );
    });
    continue;
  }

  test(`config generation rejects the unresolved ${record.id} compatibility boundary`, async (t) => {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    const docker = await checkout.installCommand("docker", fakeDocker);
    const effective = join(checkout.root, "cpa/config.yaml");
    await writeFile(
      join(checkout.root, "cpa/config.yaml.example"),
      record.baselineYaml,
    );
    await writeFile(
      join(checkout.root, "cpa/config.yaml.override"),
      record.overrideYaml,
    );
    await writeFile(effective, "previous: effective\n");

    const result = checkout.runCli(["generate"], {
      PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    });

    assert.equal(result.status, 1);
    const diagnostic =
      record.id === "duplicate-keys"
        ? "the upstream baseline contains duplicate mapping keys"
        : "the upstream baseline must contain exactly one YAML document";
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
    assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
  });
}

test("repeated config generation backs up the first generated bytes", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const environment = {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMPOSE_OUTPUT: "x-cpa-stack-override:\n  debug: true\nservices: {}\n",
  };

  const first = checkout.runCli(["generate"], environment);
  assert.equal(first.status, 0, first.stderr);
  const effective = join(checkout.root, "cpa/config.yaml");
  const firstGeneratedBytes = await readFile(effective);

  const second = checkout.runCli(["generate"], {
    ...environment,
    COMPOSE_OUTPUT: "x-cpa-stack-override:\n  debug: false\nservices: {}\n",
  });

  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    await readFile(join(checkout.root, "cpa/config.yaml.backup")),
    firstGeneratedBytes,
  );
  assert.deepEqual(parse(await readFile(effective, "utf8")), {
    port: 8317,
    debug: false,
  });
});

test("config generation rotates the previous effective config into a secure backup", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const effective = join(checkout.root, "cpa/config.yaml");
  const backup = join(checkout.root, "cpa/config.yaml.backup");
  await writeFile(effective, "previous: effective\n", { mode: 0o644 });
  await writeFile(backup, "older: backup\n", { mode: 0o644 });

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMPOSE_OUTPUT: "x-cpa-stack-override:\n  debug: true\nservices: {}\n",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parse(await readFile(effective, "utf8")), {
    port: 8317,
    debug: true,
  });
  assert.equal(await readFile(backup, "utf8"), "previous: effective\n");
  assert.equal((await stat(effective)).mode & 0o777, 0o600);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
});

test("a backup replacement failure keeps the effective config and removes staged files", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const effective = join(checkout.root, "cpa/config.yaml");
  const backup = join(checkout.root, "cpa/config.yaml.backup");
  await writeFile(effective, "previous: effective\n");
  await mkdir(backup);
  await writeFile(join(backup, "keep"), "directory blocks replacement\n");

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMPOSE_OUTPUT: "x-cpa-stack-override:\n  debug: true\nservices: {}\n",
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: could not preserve the existing configuration\n",
  );
  assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
  assert.equal(
    await readFile(join(backup, "keep"), "utf8"),
    "directory blocks replacement\n",
  );
  assert.deepEqual(
    (await readdir(join(checkout.root, "cpa"))).filter((name) =>
      name.startsWith(".cpa-stack-generate-"),
    ),
    [],
  );
});

test("a failed final replacement keeps the old effective config after changing the backup", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const effective = join(checkout.root, "cpa/config.yaml");
  const backup = join(checkout.root, "cpa/config.yaml.backup");
  const faultInjection = join(
    checkout.root,
    "test/fixtures/fail-effective-rename.ts",
  );
  await writeFile(effective, "previous: effective\n");
  await writeFile(backup, "older: backup\n");
  await writeFile(
    faultInjection,
    `import fs from "node:fs";
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (source, destination) => {
  if (destination === process.env.FAIL_RENAME_DESTINATION) {
    const error = new Error("synthetic final replacement failure");
    error.code = "EIO";
    throw error;
  }
  await rename(source, destination);
};
`,
  );

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMPOSE_OUTPUT: "x-cpa-stack-override:\n  debug: true\nservices: {}\n",
    FAIL_RENAME_DESTINATION: effective,
    NODE_OPTIONS: `--import=${faultInjection}`,
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: could not replace the effective configuration\n",
  );
  assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
  assert.equal(await readFile(backup, "utf8"), "previous: effective\n");
  assert.deepEqual(
    (await readdir(join(checkout.root, "cpa"))).filter((name) =>
      name.startsWith(".cpa-stack-generate-"),
    ),
    [],
  );
});

for (const [label, relativePath] of [
  ["upstream baseline", "cpa/config.yaml.example"],
  ["stack override", "cpa/config.yaml.override"],
  ["repository environment", ".env"],
] as const) {
  test(`config generation reports a missing ${label}`, async (t) => {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    await rm(join(checkout.root, relativePath));

    const result = checkout.runCli(["generate"]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `cpa-stack: required file not found: ${join(checkout.root, relativePath)}\n`,
    );
  });
}

test("config generation reports missing Docker Compose", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());

  const result = checkout.runCli(["generate"], { PATH: "" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "cpa-stack: Docker with Compose is required\n");
});

test("config generation reports Docker without Compose support", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    VERSION_STATUS: "1",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "cpa-stack: Docker Compose is required\n");
});

test("invalid YAML leaves the existing effective config and backup unchanged", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const baseline = join(checkout.root, "cpa/config.yaml.example");
  const effective = join(checkout.root, "cpa/config.yaml");
  const backup = join(checkout.root, "cpa/config.yaml.backup");
  await writeFile(baseline, "value: [\n");
  await writeFile(effective, "previous: effective\n");
  await writeFile(backup, "older: backup\n");

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cpa-stack: the upstream baseline is not supported YAML\n",
  );
  assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
  assert.equal(await readFile(backup, "utf8"), "older: backup\n");
});

for (const [label, composeOutput, diagnostic] of [
  [
    "invalid Compose YAML",
    "x-cpa-stack-override: [\n",
    "the resolved Compose configuration is not supported YAML",
  ],
  [
    "a missing resolved stack override",
    "services: {}\n",
    "the resolved stack override must be a mapping",
  ],
  [
    "a scalar resolved stack override",
    "x-cpa-stack-override: scalar\nservices: {}\n",
    "the resolved stack override must be a mapping",
  ],
] as const) {
  test(`${label} preserves files and removes staged secrets`, async (t) => {
    const checkout = await createTestCheckout();
    t.after(() => checkout.cleanup());
    const docker = await checkout.installCommand("docker", fakeDocker);
    const effective = join(checkout.root, "cpa/config.yaml");
    const backup = join(checkout.root, "cpa/config.yaml.backup");
    await writeFile(effective, "previous: effective\n");
    await writeFile(backup, "older: backup\n");

    const result = checkout.runCli(["generate"], {
      PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
      COMPOSE_OUTPUT: composeOutput,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, `cpa-stack: ${diagnostic}\n`);
    assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
    assert.equal(await readFile(backup, "utf8"), "older: backup\n");
    assert.deepEqual(
      (await readdir(join(checkout.root, "cpa"))).filter((name) =>
        name.startsWith(".cpa-stack-generate-"),
      ),
      [],
    );
  });
}

test("failed Compose interpolation preserves files without printing resolved secrets", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const docker = await checkout.installCommand("docker", fakeDocker);
  const effective = join(checkout.root, "cpa/config.yaml");
  const backup = join(checkout.root, "cpa/config.yaml.backup");
  await writeFile(effective, "previous: effective\n");
  await writeFile(backup, "older: backup\n");

  const result = checkout.runCli(["generate"], {
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
    COMPOSE_STATUS: "1",
    COMPOSE_ERROR: "resolved-secret-value\n",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "cpa-stack: could not interpolate the stack override\n",
  );
  assert.doesNotMatch(result.stderr, /resolved-secret-value/);
  assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
  assert.equal(await readFile(backup, "utf8"), "older: backup\n");
  assert.deepEqual(
    (await readdir(join(checkout.root, "cpa"))).filter((name) =>
      name.startsWith(".cpa-stack-generate-"),
    ),
    [],
  );
});

test("a handled signal removes secret-bearing generation files", async (t) => {
  const checkout = await createTestCheckout();
  t.after(() => checkout.cleanup());
  const ready = join(checkout.root, "compose-ready");
  const effective = join(checkout.root, "cpa/config.yaml");
  await writeFile(effective, "previous: effective\n");
  const docker = await checkout.installCommand(
    "docker",
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.at(-1) === "version") {
  process.exit(0);
}
const input = args[args.indexOf("-f") + 1];
writeFileSync(process.env.READY_FILE, input);
setInterval(() => {}, 1000);
`,
  );
  const child = spawn(
    process.execPath,
    [join(checkout.root, "bin/cpa-stack.ts"), "generate"],
    {
      cwd: checkout.outsideRoot,
      env: {
        ...process.env,
        PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
        READY_FILE: ready,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await waitForPath(ready);
  const composeInput = await readFile(ready, "utf8");
  assert.equal((await stat(composeInput)).mode & 0o777, 0o600);
  child.kill("SIGTERM");
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );

  assert.deepEqual(result, { code: 143, signal: null });
  assert.equal(stderr, "");
  assert.equal(await readFile(effective, "utf8"), "previous: effective\n");
  await assert.rejects(access(composeInput));
});
