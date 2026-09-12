import { OperationalError } from "./errors.ts";
import { Lifecycle } from "./lifecycle.ts";
import type { RepositoryPaths } from "./paths.ts";
import { signalExitStatuses } from "./signals.ts";

const usage =
  "Usage: cpa-stack {sync|generate|restart}\nRequires Node.js >=24.12.0.\n";

type CommandName = "sync" | "generate" | "restart";

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
  return value === "sync" || value === "generate" || value === "restart";
}

export async function executeCli(options: CliOptions): Promise<number> {
  const [command] = options.args;
  if (
    options.args.length !== 1 ||
    command === undefined ||
    !isCommandName(command)
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
    await options.operations[command]({ lifecycle, paths: options.paths });
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
