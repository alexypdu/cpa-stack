import { readClientApiKey } from "./client-api-key.ts";
import { OperationalError } from "./errors.ts";
import { Lifecycle } from "./lifecycle.ts";
import type { RepositoryPaths } from "./paths.ts";
import { signalExitStatuses } from "./signals.ts";

const usage =
  "Usage: cpa-stack {sync|generate|bounce}\n" +
  "       cpa-stack client-api-key [client]\n" +
  "Requires Node.js >=24.12.0.\n";

type CommandName = "sync" | "generate" | "bounce";

export interface OperationContext {
  lifecycle: Lifecycle;
  paths: RepositoryPaths;
}

export type Operation = (context: OperationContext) => Promise<void>;
export type Operations = Record<CommandName, Operation>;

export interface CliOptions {
  args: string[];
  paths: RepositoryPaths;
  operations: Operations;
}

function isCommandName(value: string): value is CommandName {
  return value === "sync" || value === "generate" || value === "bounce";
}

export async function executeCli(options: CliOptions): Promise<number> {
  const [command, client] = options.args;
  if (
    command === undefined ||
    (!isCommandName(command) && command !== "client-api-key") ||
    (command === "client-api-key"
      ? options.args.length > 2 ||
        (client !== undefined &&
          client.match(/^[a-z0-9]+(?:-[a-z0-9]+)*/)?.[0] !== client)
      : options.args.length !== 1)
  ) {
    process.stderr.write(usage);
    return 2;
  }

  const lifecycle = new Lifecycle();
  let status = 0;
  let signalStatus: number | undefined;
  const signalHandlers = Object.entries(signalExitStatuses).map(
    ([signal, exitStatus]) => {
      const handler = () => {
        if (signalStatus !== undefined) {
          return;
        }
        signalStatus = exitStatus;
        lifecycle.abortController.abort();
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    },
  );

  try {
    if (command === "client-api-key") {
      process.stdout.write(await readClientApiKey(options.paths, client));
    } else {
      await options.operations[command]({ lifecycle, paths: options.paths });
    }
    status = signalStatus ?? 0;
  } catch (error) {
    if (signalStatus !== undefined) {
      status = signalStatus;
    } else {
      status = 1;
      const message =
        error instanceof OperationalError
          ? error.message
          : "unexpected internal failure";
      process.stderr.write(`cpa-stack: ${message}\n`);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }

  return lifecycle.finish(status);
}
