# Verification

This package was verified from the #227 branch with Bun `1.4.2`, TypeScript
`7.0.2`, and Node.js `v24.20.0` (the current LTS used for the external smoke
tests). No tag, GitHub Release, or npm publication was performed.

## External tarball matrix

`bun run test:package-consumer` packs the package, creates a separate temporary
consumer for every case, installs the tarball and registry dependencies with
Bun, checks that no dependency links into the workspace, typechecks with
`skipLibCheck: false`, and runs the compiled consumer under both Bun and Node.

The matrix passed in all six isolated cells:

| Consumer | Installed optional provider(s) |
| --- | --- |
| `core-only` | none |
| `zod-only` | `zod@4.5.4` |
| `valibot-only` | `valibot@1.4.2` |
| `arktype-only` | `arktype@2.2.3` |
| `json-schema` | none |
| `all-providers` | Zod, Valibot, ArkType |

The matrix also verifies the published package manifest, optional peer
metadata, root and provider subpath exports, and a tarball with SHA-256:

```text
bceec777c279bf55706f45272e76a56d3238efd69dfa2a344731e50de4eef285
```

`@types/node@26.1.2` is installed only in the temporary consumer projects so
ArkType's own declarations can be checked without weakening `skipLibCheck` or
adding Node types to this package's runtime dependencies.

## Package and monorepo gates

After building the monorepo, all required gates passed:

```text
better-effect-schema: 89 runtime tests, 43 conformance tests (386 expects),
type tests, 9 examples, source/package boundary checks, external tarball
matrix, publint, Bun/npm release dry artifacts, and npm pack --dry-run.

monorepo: build, typecheck (12/12), lint (11/11), format:check (11/11),
publint (11/11), and bun run check (15/15).
```

The first standalone monorepo typecheck on a clean checkout can run before
MQ build artifacts exist; rerunning it after `bun run build` passed. The final
`bun run check` was executed after that build and passed, including package
checks, public type checks, package consumers, release dry-run, documentation,
and release routing tests.

The package boundary audit confirms that root declarations remain
provider-neutral, public declarations do not expose internal modules, adapter
entrypoints are present in the export map, optional peers are marked optional,
and the packed artifact contains documentation without source, tests, examples,
or workspace-only files. The allowlist intentionally includes
`docs/valibot.md`.
