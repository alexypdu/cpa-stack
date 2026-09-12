import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const gitLocalEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HUSKY: "0" };
  for (const name of gitLocalEnvironmentVariables) {
    delete environment[name];
  }
  return environment;
}

export async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

export interface TestCheckout {
  root: string;
  outsideRoot: string;
  runCli(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  runLegacyCli(
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string>;
  runFixtureCli(
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string>;
  startFixtureCli(
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): ChildProcessWithoutNullStreams;
  installCommand(name: string, source: string): Promise<string>;
  replaceLegacyCli(source: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createTestCheckout(): Promise<TestCheckout> {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "cpa-stack-test-")),
  );
  const root = join(workspace, "checkout");
  const outsideRoot = join(workspace, "outside");

  await mkdir(root, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });

  for (const path of [
    "bin",
    "src",
    "test/fixtures",
    "cpa-stack",
    "package.json",
    ".gitignore",
  ]) {
    await cp(join(sourceRoot, path), join(root, path), { recursive: true });
  }
  await symlink(
    join(sourceRoot, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );

  await mkdir(join(root, "cpa"), { recursive: true });
  await writeFile(
    join(root, ".env"),
    "CPA_MANAGEMENT_KEY=synthetic-management-key\n" +
      "CPA_KEEPER_LOGIN_PASSWORD=synthetic-login-password\n" +
      "CPA_CLIENT_API_KEY=synthetic-client-key\n",
  );
  await writeFile(
    join(root, "docker-compose.yml"),
    "services:\n" +
      "  cli-proxy-api:\n" +
      "    image: eceasy/cli-proxy-api:v1.0.0\n" +
      "  cpa-usage-keeper:\n" +
      "    image: ghcr.io/willxup/cpa-usage-keeper:v1.0.0\n",
  );
  await writeFile(join(root, "cpa/config.yaml.example"), "port: 8317\n");
  await writeFile(join(root, "cpa/config.yaml.override"), "debug: false\n");

  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "CPA Stack Tests"],
    ["config", "user.email", "tests@example.invalid"],
    ["add", "."],
    ["commit", "-qm", "test: initialize synthetic checkout"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: isolatedGitEnvironment(),
    });
    if (result.status !== 0) {
      throw new Error(`could not initialize test checkout: ${result.stderr}`);
    }
  }

  return {
    root,
    outsideRoot,
    runCli(args, env = {}) {
      return spawnSync(
        process.execPath,
        [join(root, "bin/cpa-stack.ts"), ...args],
        {
          cwd: outsideRoot,
          encoding: "utf8",
          env: { ...process.env, ...env },
        },
      );
    },
    runLegacyCli(args, env = {}) {
      return spawnSync(join(root, "cpa-stack"), args, {
        cwd: outsideRoot,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    },
    runFixtureCli(args, env = {}) {
      return spawnSync(
        process.execPath,
        [join(root, "test/fixtures/fixture-cli.ts"), ...args],
        {
          cwd: outsideRoot,
          encoding: "utf8",
          env: { ...process.env, ...env },
        },
      );
    },
    startFixtureCli(args, env = {}) {
      const child = spawn(
        process.execPath,
        [join(root, "test/fixtures/fixture-cli.ts"), ...args],
        {
          cwd: outsideRoot,
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin.end();
      return child;
    },
    async installCommand(name, source) {
      const path = join(root, "test-bin", name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      await chmod(path, 0o755);
      return path;
    },
    async replaceLegacyCli(source) {
      const path = join(root, "cpa-stack");
      await writeFile(path, source);
      await chmod(path, 0o755);
    },
    async cleanup() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
