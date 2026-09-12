#!/usr/bin/env node

import { bounceOperation } from "../../src/bounce.ts";
import { executeCli, type Operation } from "../../src/cli.ts";
import { OperationalError } from "../../src/errors.ts";
import { resolveRepositoryPaths } from "../../src/paths.ts";

const paths = resolveRepositoryPaths(new URL("../..", import.meta.url));
const pendingOperation: Operation = async () => {
  throw new OperationalError("command implementation is pending");
};

process.exitCode = await executeCli({
  args: process.argv.slice(2),
  paths,
  operations: {
    sync: pendingOperation,
    generate: pendingOperation,
    bounce: bounceOperation,
  },
});
