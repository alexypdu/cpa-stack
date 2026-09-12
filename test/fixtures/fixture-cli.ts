#!/usr/bin/env node

import { copyFile } from "node:fs/promises";

import { executeCli } from "../../src/cli.ts";
import { OperationalError } from "../../src/errors.ts";
import { resolveRepositoryPaths } from "../../src/paths.ts";
import { runCommand } from "../../src/process.ts";

const paths = resolveRepositoryPaths(new URL("../..", import.meta.url));

process.exitCode = await executeCli({
  args: process.argv.slice(2),
  paths,
  operations: {
    sync: async ({ lifecycle, paths: operationPaths }) => {
      const action = process.env.FIXTURE_ACTION;
      if (action === undefined) {
        process.stdout.write(`${operationPaths.root}\n`);
        return;
      }

      const temporary = process.env.FIXTURE_TEMPORARY;
      const target = process.env.FIXTURE_TARGET;
      const rollback = process.env.FIXTURE_ROLLBACK;
      if (
        temporary === undefined ||
        target === undefined ||
        rollback === undefined
      ) {
        throw new OperationalError("fixture paths are required");
      }

      lifecycle.trackTemporary(temporary);
      lifecycle.trackTemporary(rollback);
      const disarm = lifecycle.onFailure(async () =>
        copyFile(rollback, target),
      );
      if (action === "cleanup-success") {
        disarm();
        return;
      }
      throw new OperationalError("synthetic operation failure");
    },
    generate: async () => {
      throw new OperationalError("synthetic generation failure");
    },
    bounce: async ({ lifecycle, paths: operationPaths }) => {
      const executable = process.env.FIXTURE_EXECUTABLE;
      const args = JSON.parse(process.env.FIXTURE_ARGS ?? "[]") as string[];
      if (executable === undefined) {
        return;
      }

      const action = process.env.FIXTURE_ACTION;
      if (action === "signal" || action === "external-failure") {
        const temporary = process.env.FIXTURE_TEMPORARY;
        const target = process.env.FIXTURE_TARGET;
        const rollback = process.env.FIXTURE_ROLLBACK;
        if (
          temporary === undefined ||
          target === undefined ||
          rollback === undefined
        ) {
          throw new OperationalError("fixture paths are required");
        }
        lifecycle.trackTemporary(temporary);
        lifecycle.trackTemporary(rollback);
        lifecycle.onFailure(async () => copyFile(rollback, target));
      }

      const result = await runCommand(executable, args, {
        cwd: operationPaths.root,
        env: process.env,
        signal: lifecycle.abortController.signal,
      });
      if (action === "external-failure" && result.status !== 0) {
        throw new OperationalError(
          `synthetic command failed with status ${result.status}`,
        );
      }
      process.stdout.write(JSON.stringify(result));
    },
  },
});
