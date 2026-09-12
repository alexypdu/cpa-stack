import { rm } from "node:fs/promises";

interface RollbackAction {
  active: boolean;
  run: () => Promise<void>;
}

export class Lifecycle {
  readonly abortController = new AbortController();
  readonly #temporaryPaths: string[] = [];
  readonly #rollbacks: RollbackAction[] = [];
  #finished = false;

  trackTemporary(path: string): void {
    this.#temporaryPaths.push(path);
  }

  onFailure(run: () => Promise<void>): () => void {
    const action = { active: true, run };
    this.#rollbacks.push(action);
    return () => {
      action.active = false;
    };
  }

  async finish(status: number): Promise<number> {
    if (this.#finished) {
      return status;
    }
    this.#finished = true;
    let finalStatus = status;

    if (status !== 0) {
      for (const action of this.#rollbacks.toReversed()) {
        if (!action.active) {
          continue;
        }
        try {
          await action.run();
        } catch {
          finalStatus = 1;
        }
      }
    }

    for (const path of this.#temporaryPaths.toReversed()) {
      try {
        await rm(path, { force: true, recursive: true });
      } catch {
        finalStatus = 1;
      }
    }

    return finalStatus;
  }
}
