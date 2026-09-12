---
status: accepted
---

# TypeScript CLI with Compose-owned interpolation

Rewrite the shell CLI in TypeScript to make its behavior easier to test and extend. This is a personal, repository-local tool, so requiring Node.js is acceptable. The decision is accepted; implementation is pending. The rewrite comes first, with client API key retrieval and other new features deferred.

## Keep Compose as the interpolation authority

TypeScript will orchestrate Docker Compose rather than reproduce its environment-file and interpolation semantics. Compose will continue resolving the stack override using the repository `.env` and inherited environment. `dotenv` and general-purpose expansion packages are not assumed to be compatible with Compose's required-variable expressions, empty-versus-unset distinctions, escaping, and precedence.

Use `yaml` to parse the upstream baseline and resolved stack override, and `deepmerge` to combine their values. Configure array replacement explicitly: mappings merge recursively, override values win, and override arrays replace baseline arrays entirely. Concatenation would retain baseline client API keys and would prevent an empty override array from clearing a baseline array.

Do not build a custom comment-preserving merge layer. Generated effective config may lose comments and change formatting. Leave source baseline and override comments untouched during config generation, and use `yaml`'s document API to preserve comments when release sync edits image pins in `docker-compose.yml`. A downloaded upstream baseline remains the upstream release's file.

## Execution and compatibility

- Use Node.js 24 LTS, minimum 24.12.0, to execute erasable TypeScript directly; no compilation step or `tsx` runtime is required. Run `tsc --noEmit` separately for type checking.
- Expose `sync`, `generate`, and `restart` through npm scripts and a `cpa-stack` package executable linked from the clone with `npm link`. Remove the old shell entry point. Registry publication and registry-backed `npx` execution are not part of this decision.
- Preserve command behavior except for the agreed invocation and generated-comment/formatting changes. Preserve dirty-file protection, release validation, image-availability checks, baseline/image coupling, backups, rollback, temporary-file cleanup, and secret-file permissions.
- Keep release sync, config generation, and stack restart separate. Restart must not implicitly sync or generate, and detecting no immediate service exit must not be presented as a readiness guarantee.
- Eliminate `yq` from runtime and test dependencies. It may be used once during migration to capture synthetic reference fixtures; subsequent tests compare against those saved expectations. Use Node's built-in `node:test` and `node:assert/strict`, with isolated command boundaries and Compose-backed interpolation integration tests that do not start containers. Report suspected existing bugs separately rather than silently changing behavior during migration.

## Consequences

The CLI gains testable TypeScript boundaries without taking ownership of Compose's interpolation language. Docker Compose remains required for config generation, while YAML merging becomes an explicit, tested package configuration. Native TypeScript execution is intended for the local clone; publishing a distributable npm package would require revisiting Node's restrictions on TypeScript under `node_modules`.

Implementation specs and operator documentation updates follow separately. The domain glossary is unchanged because this decision changes implementation, not the meanings of the domain operations or configuration layers.
