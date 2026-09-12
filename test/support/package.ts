import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createTestCheckout,
  isolatedGitEnvironment,
  type TestCheckout,
} from "./checkout.ts";

export interface PackageFixture {
  checkout: TestCheckout;
  linkedExecutable: string;
  environment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  runNpm(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  runLinked(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  assertCheckoutDependenciesUnchanged(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createPackageFixture(): Promise<PackageFixture> {
  const checkout = await createTestCheckout();
  try {
    const npmRoot = join(checkout.outsideRoot, "npm");
    const prefix = join(npmRoot, "prefix");
    const cache = join(npmRoot, "cache");
    const userConfig = join(npmRoot, "user-npmrc");
    const globalConfig = join(npmRoot, "global-npmrc");
    const nodeModules = join(checkout.root, "node_modules");
    const originalNodeModules = await realpath(nodeModules);

    await mkdir(prefix, { recursive: true });
    await mkdir(cache, { recursive: true });
    await writeFile(userConfig, "");
    await writeFile(globalConfig, "");

    const environment = (overrides: NodeJS.ProcessEnv = {}) => {
      const inherited = isolatedGitEnvironment();
      for (const name of Object.keys(inherited)) {
        if (name.toLowerCase().startsWith("npm_config_")) {
          delete inherited[name];
        }
      }
      return {
        ...inherited,
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_PACKAGE_LOCK: "false",
        NPM_CONFIG_PREFIX: prefix,
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_USERCONFIG: userConfig,
        ...overrides,
      };
    };
    const runNpm = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync("npm", args, {
        cwd: checkout.outsideRoot,
        encoding: "utf8",
        env: environment(env),
        timeout: 30_000,
      });

    const linked = spawnSync("npm", ["link", "--ignore-scripts", "--offline"], {
      cwd: checkout.root,
      encoding: "utf8",
      env: environment(),
      timeout: 30_000,
    });
    if (linked.status !== 0) {
      throw new Error(
        `could not npm link package: ${linked.error ?? linked.stderr}`,
      );
    }

    const linkedExecutable = join(prefix, "bin", "cpa-stack");
    await access(linkedExecutable);

    return {
      checkout,
      linkedExecutable,
      environment,
      runNpm,
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
