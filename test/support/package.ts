import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  createTestCheckout,
  isolatedGitEnvironment,
  type TestCheckout,
} from "./checkout.ts";

export interface PackageFixture {
  checkout: TestCheckout;
  linkedExecutable: string;
  runPnpm(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  runLinked(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  assertCheckoutDependenciesUnchanged(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createPackageFixture(): Promise<PackageFixture> {
  const checkout = await createTestCheckout();
  try {
    const packageRoot = join(checkout.outsideRoot, "pnpm");
    const home = join(packageRoot, "home");
    const pnpmHome = join(packageRoot, "pnpm-home");
    const nodeModules = join(checkout.root, "node_modules");
    const originalNodeModules = await realpath(nodeModules);
    const pnpm = process.env.npm_execpath ?? "pnpm";

    await mkdir(home, { recursive: true });
    await mkdir(join(pnpmHome, "bin"), { recursive: true });

    const environment = (overrides: NodeJS.ProcessEnv = {}) => {
      const inherited = isolatedGitEnvironment();
      for (const name of Object.keys(inherited)) {
        if (/^(npm_config_|pnpm_)/i.test(name)) {
          delete inherited[name];
        }
      }
      return {
        ...inherited,
        HOME: home,
        PNPM_HOME: pnpmHome,
        XDG_CONFIG_HOME: join(packageRoot, "config"),
        XDG_DATA_HOME: join(packageRoot, "data"),
        XDG_CACHE_HOME: join(packageRoot, "cache"),
        XDG_STATE_HOME: join(packageRoot, "state"),
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        pnpm_config_verify_deps_before_run: "false",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        PATH: `${join(pnpmHome, "bin")}:${pnpmHome}:${process.env.PATH ?? ""}`,
        ...overrides,
      };
    };
    // Use the installed pnpm without downloading it again into the isolated cache.
    const runPnpmAt = (
      cwd: string,
      args: string[],
      env: NodeJS.ProcessEnv = {},
    ) =>
      spawnSync(pnpm, ["with", "current", ...args], {
        cwd,
        encoding: "utf8",
        env: environment(env),
        timeout: 30_000,
      });

    const binResult = runPnpmAt(checkout.root, ["bin", "-g"]);
    if (binResult.status !== 0) {
      throw new Error(
        `could not locate pnpm global bin: ${binResult.error ?? binResult.stderr}`,
      );
    }
    const globalBin = binResult.stdout.trim();
    const binWithinSandbox = relative(packageRoot, globalBin);
    if (
      !isAbsolute(globalBin) ||
      binWithinSandbox.startsWith("..") ||
      isAbsolute(binWithinSandbox)
    ) {
      throw new Error("pnpm global bin must stay inside the package sandbox");
    }

    const linked = runPnpmAt(checkout.root, [
      "add",
      "-g",
      ".",
      "--offline",
      "--ignore-scripts",
    ]);
    if (linked.status !== 0) {
      throw new Error(
        `could not pnpm add global package: ${linked.error ?? linked.stderr}`,
      );
    }

    const linkedExecutable = join(globalBin, "cpa-stack");
    await access(linkedExecutable);

    return {
      checkout,
      linkedExecutable,
      runPnpm: (args, env) => runPnpmAt(checkout.outsideRoot, args, env),
      runLinked(args, env = {}) {
        return spawnSync(linkedExecutable, args, {
          cwd: checkout.outsideRoot,
          encoding: "utf8",
          env: environment(env),
          timeout: 30_000,
        });
      },
      async assertCheckoutDependenciesUnchanged() {
        if (!(await lstat(nodeModules)).isSymbolicLink()) {
          throw new Error(
            "the synthetic checkout node_modules link was replaced",
          );
        }
        if ((await realpath(nodeModules)) !== originalNodeModules) {
          throw new Error(
            "the synthetic checkout node_modules link was changed",
          );
        }
      },
      cleanup: () => checkout.cleanup(),
    };
  } catch (error) {
    await checkout.cleanup();
    throw error;
  }
}
