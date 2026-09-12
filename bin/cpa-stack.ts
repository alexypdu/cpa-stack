#!/usr/bin/env node

import { executeCli, type Operation } from "../src/cli.ts";
import { OperationalError } from "../src/errors.ts";
import { generate } from "../src/generate.ts";
import { resolveRepositoryPaths } from "../src/paths.ts";
import { syncOperation } from "../src/sync.ts";

const paths = resolveRepositoryPaths(new URL("..", import.meta.url));
const pendingOperation: Operation = async () => {
  throw new OperationalError("command implementation is pending");
};

process.exitCode = await executeCli({
  args: process.argv.slice(2),
  paths,
  operations: {
    sync: syncOperation,
    generate,
    restart: pendingOperation,
  },
});
