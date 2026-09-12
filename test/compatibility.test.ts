import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import deepmerge from "deepmerge";

interface CompatibilityManifest {
  reference: {
    shellCommit: string;
    yq: string;
  };
  mergeCases: Array<{
    id: string;
    accepted: boolean;
    baseline?: unknown;
    override?: unknown;
    expected?: unknown;
  }>;
  yamlBoundaryCases: Array<{
    id: string;
    accepted: boolean;
    baselineYaml: string;
    overrideYaml: string;
    status: number;
    outputJsonText: string;
    compatibilityConcern?: boolean;
  }>;
}

interface CommandRecords {
  records: Array<{ id: string; command: string }>;
}

const compatibility = JSON.parse(
  await readFile(
    new URL("./fixtures/compatibility/manifest.json", import.meta.url),
    "utf8",
  ),
) as CompatibilityManifest;
const commandRecords = JSON.parse(
  await readFile(
    new URL("./fixtures/compatibility/command-records.json", import.meta.url),
    "utf8",
  ),
) as CommandRecords;

test("saved merge records cover the accepted compatibility matrix", () => {
  const ids = new Set(compatibility.mergeCases.map(({ id }) => id));

  assert.deepEqual(
    [
      "recursive-mappings",
      "baseline-only-values",
      "scalar-arrays-replace",
      "mapping-arrays-replace",
      "nested-arrays-replace",
      "empty-array-clears",
      "null-overrides-scalar",
      "mapping-to-scalar",
      "scalar-to-mapping",
      "root-sequence",
      "root-scalar",
    ].filter((id) => !ids.has(id)),
    [],
  );
  assert.equal(compatibility.reference.shellCommit, "9d85ad5");
  assert.match(compatibility.reference.yq, /^mikefarah\/yq v4\./);
});

test("deepmerge with array replacement matches accepted merge records", () => {
  for (const record of compatibility.mergeCases) {
    if (
      !record.accepted ||
      record.baseline === undefined ||
      record.override === undefined
    ) {
      continue;
    }

    const actual = deepmerge(
      record.baseline as object,
      record.override as object,
      { arrayMerge: (_destination, source) => source },
    );
    assert.deepEqual(actual, record.expected, record.id);
  }
});

test("YAML boundary records include concrete captured inputs and output", () => {
  for (const record of compatibility.yamlBoundaryCases) {
    assert.ok(record.baselineYaml.length > 0, record.id);
    assert.ok(record.overrideYaml.length > 0, record.id);
    assert.equal(record.status, record.accepted ? 0 : 1, record.id);
    assert.ok(record.outputJsonText.endsWith("\n"), record.id);
  }
});

test("lossy YAML boundaries remain explicit compatibility concerns", () => {
  const concerns = compatibility.yamlBoundaryCases
    .filter(({ compatibilityConcern }) => compatibilityConcern)
    .map(({ id }) => id)
    .sort();

  assert.deepEqual(concerns, [
    "custom-tags",
    "duplicate-keys",
    "multiple-documents",
  ]);
});

test("saved command records cover historical regression behavior", () => {
  const ids = new Set(commandRecords.records.map(({ id }) => id));

  assert.deepEqual(
    [
      "manifest-before-adoption",
      "independent-service-availability",
      "baseline-byte-regeneration-guidance",
      "rotating-effective-config-backup",
      "immediate-exit-only-restart-check",
    ].filter((id) => !ids.has(id)),
    [],
  );
  assert.ok(
    commandRecords.records.every(
      ({ command }) =>
        command === "sync" || command === "generate" || command === "restart",
    ),
  );
});
