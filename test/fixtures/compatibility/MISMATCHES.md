# YAML compatibility decisions still required

These records describe shell behavior that the planned `yaml` and `deepmerge` implementation cannot preserve automatically. They are not approved behavior changes.

## Duplicate mapping keys

The shell CLI and Mike Farah `yq` accept duplicate mapping keys and preserve both entries in emitted output. A JavaScript object cannot represent both entries, and `yaml` rejects duplicate keys by default.

**Status:** unresolved. Issue #12 must reject the input with an actionable diagnostic or receive explicit approval for another behavior.

## Custom YAML tags

The shell CLI accepts an unknown custom tag on a scalar. General parsing with `yaml` does not assign application semantics to unknown tags.

**Status:** unresolved. Issue #12 must reject unsupported custom tags or receive explicit approval for another behavior.

## Multiple YAML documents

The shell merge expression applies the override to every baseline document and emits multiple documents. The accepted ADR describes one mapping-shaped upstream baseline and one mapping-shaped resolved stack override.

**Status:** unresolved. Issue #12 must reject multiple documents or receive explicit approval to support them.
