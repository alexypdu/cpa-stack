# Suspected existing shell behavior

## Unavailable release reporting loses the selected tag

When a selected image is unavailable, `sync` passes the retained current tags to `stage_compose`. The shell function assigns those arguments to global shell variables named `cpa_tag` and `keeper_tag`. The later report therefore prints the retained current tag as both the selected and kept tag.

Synthetic characterization selected Keeper `v2.0.0`, inspected `ghcr.io/willxup/cpa-usage-keeper:v2.0.0`, retained `v1.0.0`, and printed:

```text
Keeper: selected v1.0.0, but its image is unavailable; kept v1.0.0.
```

**Status:** correction approved on 2026-09-12 during issue #15 implementation. The operator explicitly requested: “keep the correct message.” TypeScript reports the actual selected release and the retained release. For this example, it reports selected `v2.0.0` and kept `v1.0.0`. This approval changes only the diagnostic. Image selection and retention do not change.

The saved shell output in `command-records.json` remains unchanged as historical evidence. The TypeScript command tests in `test/sync.test.ts` check the approved output.
