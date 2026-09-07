# Verification

The package is verified with Bun and `bun:test`.

## Local gates

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test:runtime
bun run test:types
bun run build
bun run examples
bun run check:source
bun run check:package
bun run test:package
bun run publint
bun run check
```

`test:runtime` executes the files under `tests/runtime` with `bun test`.
Compile-time contracts live under `type-tests/`; they cover Standard Schema
classes, provider adapters, tagged values, encoded/props projections, and
typed failure channels.

## Boundary checks

The package check confirms that:

- root declarations do not import adapter internals or mention legacy Zod API;
- adapter entrypoints are present in the export map;
- optional peers are declared as optional;
- the packed artifact contains published documentation but no source, tests,
  examples, or workspace-only files;
- an external TypeScript/Bun consumer can use the root, Zod, and Valibot
  subpaths.

The allowlist intentionally includes `docs/valibot.md`.
