# Monorepo integration

`better-effect-schema` is an independent package. The `better-effect` core
must not import or re-export it, and provider packages remain optional peers.

## Workspace setup

```bash
bun install --frozen-lockfile
cd packages/better-effect-schema
bun run check
```

The package peers are:

```text
better-effect >=0.13.0 <0.14.0
better-result ^3.0.0
typescript >=6.0.0
arktype >=2.2.3 <3.0.0 (optional)
valibot >=1.4.2 <2 (optional)
zod >=4.5.4 <5 (optional)
```

Keep package-qualified publishing and release configuration in the repository
root. This package's implementation and checks do not create tags, publish
artifacts, or alter unrelated worktrees.

## Public boundaries

The package exports `.`, `./zod`, `./valibot`, `./arktype`, and
`./package.json`. The root declaration must stay provider-neutral; adapter
declarations may reference their own provider.

Schema operations are requirement-free `Effect<_, _, never>` values. Service
composition belongs to `better-effect` application code, while provider
translation belongs to the adapter subpaths.

## Documentation and archive audits

The published documentation includes `docs/api.md`, `docs/zod.md`,
`docs/arktype.md`, and the existing `docs/valibot.md` allowlist entry. The
package archive must not include `src`, tests, type-tests, examples, or
workspace-only links.

Useful audits from the repository root:

```bash
rg 'from ["\x27](effect|@effect/)' packages/better-effect-schema/src
rg 'from ["\x27](better-effect|better-result)/' packages/better-effect-schema/src
bun run --filter better-effect-schema check
```
