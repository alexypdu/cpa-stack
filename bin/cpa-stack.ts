#!/usr/bin/env node

import { bounceOperation } from "../src/bounce.ts";
import { executeCli } from "../src/cli.ts";
import { generate } from "../src/generate.ts";
import { resolveRepositoryPaths } from "../src/paths.ts";
import { syncOperation } from "../src/sync.ts";

const paths = resolveRepositoryPaths(new URL("..", import.meta.url));

process.exitCode = await executeCli({
  args: process.argv.slice(2),
  paths,
  operations: {
    sync: syncOperation,
    generate,
    bounce: bounceOperation,
  },
});
