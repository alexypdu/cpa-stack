import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RepositoryPaths {
  root: string;
  compose: string;
  baseline: string;
  override: string;
  effective: string;
  backup: string;
  environment: string;
}

export function resolveRepositoryPaths(rootUrl: URL): RepositoryPaths {
  const root = resolve(fileURLToPath(rootUrl));

  return {
    root,
    compose: join(root, "docker-compose.yml"),
    baseline: join(root, "cpa/config.yaml.example"),
    override: join(root, "cpa/config.yaml.override"),
    effective: join(root, "cpa/config.yaml"),
    backup: join(root, "cpa/config.yaml.backup"),
    environment: join(root, ".env"),
  };
}
