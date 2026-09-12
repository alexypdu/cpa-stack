# Suspected existing shell behavior

## Unavailable release reporting loses the selected tag

When a selected image is unavailable, `sync` passes the retained current tags to `stage_compose`. The shell function assigns those arguments to global shell variables named `cpa_tag` and `keeper_tag`. The later report therefore prints the retained current tag as both the selected and kept tag.

Synthetic characterization selected Keeper `v2.0.0`, inspected `ghcr.io/willxup/cpa-usage-keeper:v2.0.0`, retained `v1.0.0`, and printed:

```text
Keeper: selected v1.0.0, but its image is unavailable; kept v1.0.0.
```

**Status:** documented, not fixed. The TypeScript sync ticket must preserve this observable behavior or obtain explicit approval to correct it.
