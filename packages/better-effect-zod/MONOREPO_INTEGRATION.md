# Adding better-effect-zod to the better-effect monorepo

Copy this directory to:

```text
packages/better-effect-zod/
```

The package is independent from the `better-effect` core. Do not re-export it from `better-effect` and do not add Zod to the core package's dependencies.

## 1. Install the workspace

From the monorepo root:

```bash
bun install
```

The package expects these peers:

```text
better-effect >=0.13.0 <0.14.0
better-result ^3.0.0
zod >=4.5.4 <5
typescript >=6.0.0
```

## 2. Run the package gate

```bash
cd packages/better-effect-zod
bun run check
```

The scripts intentionally use portable Node.js and TypeScript commands, so they can be invoked by either `bun run` or `npm run`.

Then run the complete repository gate:

```bash
cd ../..
bun run check
```

## 3. Include the package in repository-wide publishing checks

Add `better-effect-zod` to the root `publint` filter:

```json
{
  "scripts": {
    "publint": "turbo run publint --filter=better-effect --filter=better-effect-mq --filter=better-effect-better-auth --filter=better-effect-kysely --filter=better-effect-zod"
  }
}
```

The package performs its own source, archive-boundary, and external-consumer checks. Its `release:dry` script also invokes the shared artifact validator, so the package must be present in `scripts/release-packages.json` before that script is enabled. The allowlist entry includes the documentation files intentionally published by this package:

```json
{
  "name": "better-effect-zod",
  "directory": "packages/better-effect-zod",
  "changelog": "packages/better-effect-zod/CHANGELOG.md",
  "tagPrefix": "better-effect-zod-v",
  "initialRelease": true,
  "additionalFiles": [
    "MIGRATION.md",
    "MONOREPO_INTEGRATION.md",
    "VERIFICATION.md",
    "docs/api.md",
    "docs/architecture.md"
  ]
}
```

Keep `scripts/release-route.test.ts` covered by both package-name and qualified-tag cases. The resulting release tag is:

```text
better-effect-zod-v0.1.0
```

## 4. Documentation placement

The package README is self-contained. A future site page can be created under:

```text
apps/docs/content/docs/zod.mdx
```

That page should link to this package rather than copying its entire API reference. Keep the following boundaries explicit:

- Zod remains optional and belongs only to `better-effect-zod`.
- `better-result` remains the single Result and TaggedError protocol.
- Schema operations are requirement-free `Effect<_, _, never>` values.
- Database, HTTP, queue, and configuration integrations remain adapters or recipes rather than responsibilities of the schema package.

## 5. Recommended root-level audits

After copying the package, verify:

```bash
rg 'from ["\x27](effect|@effect/)' packages/better-effect-zod
rg 'from ["\x27](better-effect|better-result)/' packages/better-effect-zod/src
bun run check
```

The first two searches should return no production imports. Historical migration text and compatibility aliases are allowed outside `src`.
