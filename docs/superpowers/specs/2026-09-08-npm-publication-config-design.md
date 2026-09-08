# npm Publication Configuration Design

## Classification

This is an architectural release-infrastructure change. It spans package
manifests, release routing, artifact validation, GitHub Actions, package-local
release notes, and maintainer documentation; runtime library code remains out
of scope.

## Goal

Make every package that the repository already declares as public and
allowlisted in `scripts/release-packages.json` independently publishable from a
qualified Git tag through npm Trusted Publishing/OIDC. The existing core route
remains `better-effect -> v<version>`; every other selected package uses its
package-qualified `<package>-v<version>` route. Apps and any package not
explicitly present in the release route table remain unpublished.

## Repository audit

The repository currently contains twelve `packages/*` workspaces. Each of the
twelve has a public package manifest (`private` is absent), a public
`publishConfig`, an explicit `files` allowlist, an `exports` map, and a
package-local `CHANGELOG.md`, except that the core intentionally uses the root
`CHANGELOG.md`. The release route table already names all twelve packages, but
the tag workflow only subscribes to seven routes, the documentation only
describes a subset, and `better-effect-mq-mongodb` lacks the `release:dry`
script that the other allowlisted packages expose.

The public package set is therefore the twelve entries already present in
`scripts/release-packages.json`:

- `better-effect`
- `better-effect-better-auth`
- `better-effect-http`
- `better-effect-kysely`
- `better-effect-mq`
- `better-effect-mq-mongodb`
- `better-effect-mq-mysql`
- `better-effect-mq-outbox`
- `better-effect-mq-postgres`
- `better-effect-mq-redis`
- `better-effect-mq-sqlite`
- `better-effect-schema`

The private applications are not release routes and must not gain npm
publication configuration.

## Design

### Release route source of truth

Keep package name, directory, package-local changelog, qualified tag prefix,
initial-release status, and extra artifact paths in
`scripts/release-packages.json`. `scripts/release-route.ts` remains the single
route resolver for both local commands and Actions. Its tests must cover every
configured package, every qualified tag shape, and rejection of lookalike or
unallowlisted tags. The root changelog is represented by the core route's
existing `CHANGELOG.md` value; all non-core routes require their own changelog.

The release workflow's tag filters must be generated/aligned with this table
for all twelve routes. No wildcard may allow a package that the resolver would
reject, and the existing `v0.1.0` core tag remains owned by `better-effect`.

### Package manifests and package scripts

Preserve each package's existing public API, export map, and file allowlist.
Add only the missing release gate to packages already selected for publication:
`better-effect-mq-mongodb` gets `release:dry`, and its `check` script invokes
that gate. All package release gates run the central artifact validator after
the package has built declarations and source maps. Do not add runtime
dependencies, alter library code, or make private apps publishable.

### Artifact validation

Extend `scripts/release-artifact.ts` so the selected package is validated in an
auth-free temporary directory with both `bun pm pack --ignore-scripts` and
`npm pack --ignore-scripts`. Expected archive contents are derived from the
selected manifest's `files` list plus the route's explicit extra paths, while
the core's existing intentional omission of `CHANGELOG.md` is preserved. The
validator must assert:

- archive name, manifest package name, and manifest version match the selected
  route;
- the package is ESM, side-effect free, and has an object export map;
- every exported runtime entry and its declaration is present in `dist`, for
  both `.mjs`/`.d.mts` and `.js`/`.d.ts` build conventions already used in the
  workspace;
- source maps contain no absolute, temporary, or `node_modules` source paths;
- the packed manifest contains no `workspace:`, `file:`, or `link:` reference;
- the archive contains exactly the manifest-derived allowlist and route-declared
  extra files, including migrations or package documentation where configured.

The validator should fail closed when a required manifest file, export target,
declaration, source map, or configured extra path is missing. It must not
require an unlisted file from the core or any package whose manifest does not
publish it.

### GitHub Actions and Trusted Publishing

Keep the reusable `publish.yml` workflow as the only publication implementation.
It receives a qualified tag, checks out that exact tag commit, resolves the
allowlisted route, validates package/tag/version/changelog consistency, runs
the selected package's quality and artifact gates, and publishes only the
selected package directory. `release-please.yml` remains the tag-triggered
caller and creates the package-specific GitHub Release from the matching
package-local/root changelog section.

Both workflows retain `id-token: write`; npm authentication is through Trusted
Publishing/OIDC and no `NPM_TOKEN` secret or npm token configuration is added.
The workflow must validate all selected package metadata rather than retaining
the core-only `workspace:` special case. The one-time initial package bootstrap
remains a documented maintainer action because npm requires the package name to
exist before a Trusted Publisher can be configured; no bootstrap or publication
is performed by this change.

### Documentation and safety

Update `README.md` and `docs/release-process.md` so the public package matrix,
qualified tag routes, package-local changelog requirement, package bootstrap
exception, artifact dry gates, OIDC setup, and non-mutating review commands
match the implementation. Document that apps remain private and that release
scripts are only for a clean maintainer checkout on `main`.

No `release.sh` mutating invocation, npm publication, tag creation, tag push, or
issue closure is part of this change. The branch must be opened as a PR against
`main` after local verification.

## Testing and verification

Add/adjust release-route and artifact-validator tests for the full twelve-route
matrix, including invalid package/tag cases and package-specific file/declaration
rules. Run the repository's `bun run check` plus the selected package checks and
non-mutating `release:dry` gates. Any package that fails its existing build or
release gate is reported as blocked instead of being excluded or bypassed.

## Files in scope

- `scripts/release-packages.json`, `scripts/release-route.ts`,
  `scripts/release-route.test.ts`, and `scripts/release-artifact.ts` for the
  route and archive contracts;
- package manifests/scripts for the missing MongoDB release gate;
- `.github/workflows/publish.yml` and `.github/workflows/release-please.yml` for
  qualified tag and OIDC publication coverage;
- `README.md`, `docs/release-process.md`, and package changelogs only where
  required to document or validate the existing public package set;
- focused release tests and package checks.

Runtime implementation files and private application manifests are explicitly
out of scope.
