# YAML compatibility boundaries

These records describe shell behavior that `yaml` and `deepmerge` do not preserve automatically. Issue #12 either preserves the observed result or rejects the input rather than silently generating a different effective config.

## Aliases

The shell merge replaces an aliased mapping when the override supplies a mapping at the alias location. Resolving the alias to a JavaScript object before `deepmerge` would instead retain baseline-only values.

**Status:** preserved. Config generation marks resolved alias locations as replacement boundaries during the merge.

## Root sequences

The shell accepts root sequences and replaces the baseline sequence with the override sequence. The accepted ADR defines the upstream baseline and resolved stack override as mapping-shaped configuration layers.

**Status:** rejected with an actionable diagnostic under the mapping-shaped configuration contract.

## Duplicate mapping keys

The shell CLI and Mike Farah `yq` accept duplicate mapping keys and preserve both entries in emitted output. A JavaScript object cannot represent both entries, and `yaml` rejects duplicate keys by default.

**Status:** rejected with an actionable diagnostic rather than silently dropping an entry.

## Custom YAML tags

The shell CLI accepts an unknown custom tag on a scalar. Its generated result retains the scalar value without the application-specific tag.

**Status:** preserved. Config generation accepts the unresolved scalar tag warning and retains the scalar value.

## Multiple YAML documents

The shell merge expression applies the override to every baseline document and emits multiple documents. The accepted ADR defines one mapping-shaped upstream baseline and one mapping-shaped resolved stack override.

**Status:** rejected with an actionable diagnostic under the single-document configuration contract.
